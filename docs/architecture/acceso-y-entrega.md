# Acceso, publicación y entrega

**Acceso con Cognito y publicación de React estático en S3 privado, servido por CloudFront con Origin Access Control (OAC), mediante CDK en TypeScript y GitHub Actions.** El circuito incorpora el acceso verificado, la configuración persistida, las rutas de intentos y starter/Runtime/S3, con Sonnet 4.6 como único modelo operativo. El nivel principal periódico, la animación opcional y el replay del contrato vigente forman parte del código. El User Pool está configurado para entregar los códigos por SES y hay un único ambiente. El diseño de animación está en [animación](animacion.md). Las restricciones elegidas por el usuario se mantienen en [plataforma](../intent/plataforma.md); las referencias técnicas están en [identidad](../reference/identidad.md), [datos y entrega](../reference/datos-y-entrega.md) y [cuenta AWS](../reference/cuenta-aws.md).

## Cognito y envío de correo con SES

Se usa **Cognito Essentials con Managed Login en español, email y contraseña, confirmación por código y recuperación administrada**. React inicia Authorization Code con PKCE y un app client público sin secreto, solicitando `lang=es`. Antes de jugar, cada usuario debe confirmar que tiene acceso a su casilla.

El pool usa **`EmailSendingAccount=DEVELOPER`** y la identidad SES `arn:aws:ses:us-east-1:387483252302:identity/dondeaprendoaws.com`, con `hello@dondeaprendoaws.com` como remitente. La plantilla nativa de Cognito usa `CONFIRM_WITH_CODE`, el asunto **«Tu código de verificación para el juego»** y HTML en español. Incluye un solo código `{####}` y explica que debe ingresarse en la pantalla donde se solicitó para confirmar el email o restablecer la contraseña. La misma configuración cubre el alta, el reenvío y la recuperación; Managed Login conserva el flujo de recuperación y la aplicación puede retomar la confirmación de una cuenta pendiente.

La actualización conserva el User Pool, el app client público sin secreto, Managed Login y sus callbacks, scopes, verificación de email y recuperación por email verificado. No se añade una Lambda de correo, un proveedor alternativo ni una abstracción de envío.

Antes de usar la identidad para destinatarios arbitrarios, la operación única de SES debe confirmar la verificación de `dondeaprendoaws.com`, publicar los registros DKIM entregados por SES en DNS y comprobar el estado de producción, envío y cuotas efectivas. Estos valores se leen en la referencia de [cuenta AWS](../reference/cuenta-aws.md), no se infieren de las cuotas predeterminadas publicadas. Cognito usa el rol de servicio nativo `AWSServiceRoleForAmazonCognitoIdpEmailService`, preparado fuera de CDK. La identidad SES y su DNS también se preparan fuera de CDK; el stack `PromptRunnerHosting` declara el `SourceArn` y el remitente para el User Pool existente. `PromptRunnerAccess` mantiene su responsabilidad separada y no requiere nuevas políticas para esta configuración.

Un error o límite de envío se informa y deja la cuenta pendiente sin confirmar; la persona puede reintentar cuando corresponda. Una falla no desconfirma cuentas ya verificadas. La disponibilidad y el ritmo de entrega dependen del estado efectivo de SES.

La cuenta actual obtiene su identidad desde `userInfo` de Cognito con los scopes `openid email`; solo se habilita después de validar el email verificado y la identidad de la sesión. No necesita una API propia ni guarda perfiles duplicados. Las contraseñas y los códigos de recuperación se ingresan en Cognito. Si se abandonó la confirmación del registro, la aplicación ofrece una pantalla de email y código para retomarla: llama directamente a las APIs públicas `ResendConfirmationCode` y `ConfirmSignUp` del mismo pool y cliente. Se puede usar un código ya recibido sin reenviar primero. No guarda el código ni autentica por confirmar; después se inicia el ingreso normal con OAuth y se valida UserInfo.

Esta pantalla cubre una limitación de Managed Login: Cognito no ofrece una entrada directa soportada para volver a confirmar una cuenta pendiente después de abandonar su flujo. `/confirm` y `/resendcode` son rutas de redirección internas, por lo que no se construyen enlaces basados en sus parámetros internos. [Endpoints administrados de Cognito](https://docs.aws.amazon.com/cognito/latest/developerguide/managed-login-endpoints.html).

El backend usa el authorizer JWT de HTTP API, con issuer/cliente y scope `prompt-runner/robot` en `/draft` y en las rutas de intentos. Lambda exige un access token del cliente esperado y valida UserInfo con email verificado y sub coincidente antes de acceder a datos. El sub validado determina las claves de borrador, solicitud, intento y cuota; no se acepta otro propietario como selector. La guarda de la pantalla no sustituye esa autorización de servidor; un JWT tampoco autoriza leer cualquier identificador.

### Sesión del navegador

El cliente público usa `oidc-client-ts` para Code Grant con PKCE S256 y validación de la transacción. El callback es `https://robotrunner.guilleojeda.com/jugar` y el retorno de logout es la portada `/` del mismo origen. En desarrollo se usan `http://localhost:5173/jugar` y `http://localhost:5173/`. La validación distingue esas rutas y conserva la exigencia de origen coincidente, protocolo permitido y ausencia de query/hash en la configuración. La configuración pública se carga de `/auth-config.json`: contiene issuer, client ID, dominio, URLs de retorno, `apiBaseUrl` y `apiScope`, nunca un secreto de cliente. CDK resuelve esos valores al publicar el assembly verificado, sin reconstruir React después del despliegue.

Los tokens y la transacción OAuth se conservan en `sessionStorage`. La recarga puede recuperar la sesión de esa pestaña, pero debe validar la identidad con Cognito antes de mostrar la cuenta. Si el access token venció, se intenta renovarlo con un refresh token válido; si la sesión ya no sirve, se pide un nuevo ingreso. Una falla transitoria ofrece reintentar y no habilita acceso a partir de un perfil viejo.

El cliente conserva las duraciones predeterminadas de Cognito: access token e ID token de una hora, refresh token de 30 días y ventana del desafío de autenticación (`AuthSessionValidity`) de tres minutos. Esta última no limita la duración de la sesión web. Los tokens emitidos confirman la duración de una hora; `DescribeUserPoolClient` informa las otras dos duraciones. La caducidad del access token permite renovar la sesión con un refresh válido; no obliga a volver a ingresar mientras esa renovación funcione. [Duraciones y unidades de Cognito](https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_CreateUserPoolClient.html).

Cerrar sesión elimina el estado local, revoca el refresh token y navega al endpoint `/logout` de Cognito para cerrar también su cookie. Una falla remota no vuelve a abrir la cuenta local y se informa al usuario. No se promete cerrar sesiones de otros dispositivos. Al abrir otra pestaña o navegador sin estado local, la persona vuelve por Managed Login y mantiene su misma cuenta e identificador.

## Acceso a la configuración del robot

El cliente solicita `openid email prompt-runner/robot`. El resource server Cognito y el scope se administran con CDK dentro del mismo pool/cliente. Una sesión emitida antes de incorporar ese scope debe volver por Managed Login; renovar un token no se usa para conceder permisos nuevos. La cuenta y su sub se conservan.

Las solicitudes a la API envían el access token en Authorization, no el ID token, cookies ni parámetros de URL. CORS permite sólo `https://robotrunner.guilleojeda.com` y el origen local de desarrollo, con GET/PUT/POST/DELETE/OPTIONS y Authorization/Content-Type. Las respuestas del borrador no se cachean. El acceso a UserInfo desde Lambda conserva la exigencia de email verificado también cuando se llama a la API fuera de React; sus errores transitorios no autorizan una lectura o escritura por defecto.

El editor conserva sus cambios pendientes en memoria mientras renueva la misma identidad y pausa las escrituras hasta validar la sesión. Cerrar sesión o cambiar de cuenta invalida las operaciones del editor anterior, incluidas respuestas tardías. No hay una copia persistente del borrador en el navegador, salvo el snapshot transitorio de una admisión ya iniciada: después de **Probar**, `sessionStorage` puede conservar la clave, versión, `animationEnabled` y payload exactos hasta confirmar o descartar esa admisión. También conserva el identificador de un intento admitido mientras su presentación está pendiente para recuperarla tras recargar. No funciona como preferencia ni como borrador alternativo y se elimina al cerrar sesión o cambiar de cuenta. [Concurrencia y recuperación del guardado](datos.md#borrador-disponible).

La API registra un resultado estructurado por solicitud en su log de Lambda: `requestId`, método, estado HTTP y código de resultado. Ese identificador permite correlacionar el error sin registrar el bearer, el borrador ni los detalles privados de las excepciones de dependencias.

### Rutas de ejecución y reproducción

Con la misma autenticación se declaran `POST /attempts`, `GET /attempt-requests/{requestKey}`, `GET /attempts/{attemptId}`, `GET /attempts?cursor=...`, `POST /attempts/{attemptId}/start`, `POST /attempts/{attemptId}/cancel`, `GET /attempts/{attemptId}/replay`, `GET /attempts/{attemptId}/decisions`, `POST /attempts/{attemptId}/presentation-complete`, `GET/PUT /animation-preference` y `GET /quota`. La interfaz usa `requestKey` para recuperar una admisión ambigua; no usa el navegador como autoridad del intento. El valor vigente de Animación se fija en cada admisión y la preferencia usa versión para resolver cambios entre pestañas. Replay e inspección devuelven proyecciones distintas sólo después de comprobar pertenencia; inspección requiere un intento terminal y entrega índice o ficha `?decision=<n>`, nunca bodies. No hay una ruta para Runtime, bodies ni ranking.

## Fundamento

El envío nativo de Cognito mediante SES conserva el mismo proveedor de identidad y sus códigos, permite usar un remitente propio y una plantilla en español, y evita una Lambda, KMS y credenciales de otro proveedor. La identidad SES se prepara una vez en AWS; CDK solo configura cómo la usa el User Pool.

Un proveedor externo como Resend añadiría una Lambda de envío, KMS y credenciales externas. Firebase cambiaría el proveedor de identidad; el acceso exclusivamente federado modificaría las condiciones de registro. Esas alternativas no forman parte del flujo elegido; sus capacidades están en [identidad y correo](../reference/identidad.md).

## Frontend y publicación

El hosting usa **un bucket S3 privado, servido por CloudFront mediante Origin Access Control (OAC)**. Vite genera tres entradas: portada HTML en `index.html`, juego React en `jugar/index.html` y privacidad HTML en `privacidad/index.html`. CloudFront sirve las URLs públicas `/`, `/jugar` y `/privacidad`; una función de viewer request reescribe sólo las dos rutas de página sin extensión a sus objetos existentes. Las páginas informativas comparten CSS y no cargan React ni autenticación. Las capturas públicas son imágenes del editor y del mapa, sin datos personales. El build y la publicación de assets y configuración se ejecutan con GitHub Actions y CDK en TypeScript; un cambio a cualquiera de esas páginas sigue el mismo circuito de checks y despliegue de `main`.

El origen canónico es `https://robotrunner.guilleojeda.com`. La misma distribución conserva S3 privado y OAC, usa un certificado ACM validado por DNS en `us-east-1` y tiene registros A/AAAA alias en la zona pública del subdominio. Las visitas por el hostname AWS redirigen al origen canónico; `/bienvenida.html` y `/index.html` redirigen a `/`, y los aliases de página con slash final o `index.html` redirigen a las rutas limpias. Los redirects conservan la query, incluidas las transacciones de acceso. Una sesión que todavía estaba en el origen AWS puede requerir volver a ingresar: `sessionStorage` no se transfiere entre orígenes. El mismo User Pool y backend conservan cuentas e intentos.

No se configura un fallback general de errores a HTML: un asset o ruta desconocidos conserva el error de S3. Las entradas y capturas tienen `no-cache`; los assets con hash mantienen caché inmutable. Cada entrega invalida también las páginas del juego y privacidad, sus aliases anteriores y las capturas. La función se asocia tanto al behavior principal como al de assets para que la URL AWS no siga siendo otro origen público.

El renderer utiliza React y sprites dentro de SVG, a partir de registros cerrados del contrato vigente y un único reloj de reproducción. El [diseño de animación](animacion.md) define clips, trayectorias y carga, con avance continuo a velocidad fija y sin controles del usuario; CSS se usa para estilos y no como un reloj independiente. El juego muestra estado, resultado, historial, replay y un mapa estático de decisiones sin ejecutar física en el navegador. La inspección se abre después del resultado y no controla la animación.

La interfaz tiene una única acción Probar: guarda el borrador actual, admite el intento y bloquea los controles de configuración y nuevos intentos mientras calcula y durante la animación automática. El toggle de Animación se guarda por usuario; cada intento captura su valor. Un intento sin animación o sin acciones muestra el resultado directamente. Los demás se reproducen antes de presentar el resultado, que también puede iniciar un replay manual desde el resultado o el historial, según [experiencia](../intent/experiencia.md).

Amplify Hosting también podría definirse con CDK y recibir publicaciones desde GitHub Actions mediante su API. Ofrece hosting y previews administrados, pero esas capacidades no están pedidas y añadirían un circuito de publicación diferente al backend CDK. S3/CloudFront mantiene una forma uniforme de entregar esta SPA y es la decisión aprobada. No se extrapola un costo mensual sin uso.

El bucket del frontend es privado y se sirve exclusivamente a través de CloudFront con OAC. El bucket de cuerpos de inferencia también es privado e independiente del bucket del frontend. Los logs operativos registran IDs, transiciones y errores; no duplican por defecto prompts, cuerpos ni tokens de autenticación. Los datos del contrato vigente no tienen caducidad automática mientras siga operativo. Los datos de prueba de contratos anteriores pueden permanecer si no afectan el flujo o eliminarse; no requieren lectores antiguos.

## Entrega automática y ambientes

La primera versión usa **un único ambiente desplegado**, en la cuenta y región elegidas. Esta decisión minimiza configuración de identidad, callbacks, Runtime y recursos. Las verificaciones reales posteriores al despliegue ocurren en el ambiente público y una regresión de integración puede llegar a participantes antes de detectarse. Las pruebas usan usuarios y datos propios identificables; no alteran historiales ajenos.

Separar prueba y público permitiría verificar integración antes de promover los mismos artefactos al público, pero duplica configuración, recursos retenidos y ejecuciones de comprobación. Para la primera versión se elige la menor carga operativa de un ambiente; se conserva la consecuencia sobre la exposición a regresiones como fundamento de esa decisión.

El circuito de entrega es:

- Pull requests ejecutan instalación reproducible, tipos, pruebas pertinentes, build y validación/synth CDK, sin credenciales de despliegue.
- `main` vuelve a verificar y despliega automáticamente por GitHub Actions. Los despliegues se serializan sin cancelar uno que esté actualizando recursos.
- GitHub obtiene credenciales temporales con OIDC; la confianza restringe repositorio y rama/environment según los claims reales. No se guardan claves AWS permanentes.
- Los roles del runtime, API y arranque tienen permisos por responsabilidad. El agente solo accede a inferencia y datos de aplicación necesarios; no recibe credenciales ni herramientas de despliegue.
- Los recursos de datos e identidad se conservan ante despliegues o reemplazos rutinarios. La aplicación admite un solo contrato de borrador, nivel, reglas y registro.
- Las comprobaciones posteriores al despliegue vinculan versión de código y entorno con acceso real, inferencia, persistencia y replay del contrato vigente. Un rollback de código no convierte ni restaura datos de contratos reemplazados.

## Ambiente operativo

La [URL pública del frontend](https://robotrunner.guilleojeda.com) ofrece el ambiente público conocido para acceso, cuenta, preparación del robot y ejecución del juego. El ambiente está en la cuenta `387483252302`, región `us-east-1`:

| Recurso                 | Identificador                                              |
| ----------------------- | ---------------------------------------------------------- |
| Acceso inicial          | Stack `PromptRunnerAccess`                                 |
| Bootstrap CDK           | Stack `CDKToolkit`, qualifier `hnb659fds`                  |
| Hosting                 | Stack `PromptRunnerHosting`                                |
| Distribución CloudFront | `E121DZBSJ73SOP`                                           |
| Origen privado          | Bucket `prompt-runner-game-website-387483252302-us-east-1` |

Para una actualización habitual, abrir una PR, esperar sus checks e integrar a `main`; Actions publica el assembly verificado. Los cambios declarativos del User Pool se entregan mediante `PromptRunnerHosting`. Los cambios de permisos requieren actualizar primero `PromptRunnerAccess` con acceso temporal de operador, siguiendo el procedimiento siguiente. La verificación de identidad SES, DNS DKIM y acceso de producción es una preparación operativa de AWS separada, no parte del stack de hosting ni del bootstrap de Access.

## Preparación del DNS público

`guilleojeda.com` pertenece a la cuenta DNS `719535286359`. La zona pública `robotrunner.guilleojeda.com` se prepara una vez en la cuenta del juego `387483252302`, fuera de `PromptRunnerHosting`, igual que las identidades operativas retenidas. Esto mantiene estable la delegación aunque se reconfigure el hosting y permite limitar los permisos del pipeline a esa zona, sin darle acceso a la cuenta padre ni permiso para crear o eliminar zonas.

Con credenciales temporales de operador, confirmar `sts get-caller-identity` antes de cada grupo de operaciones. En la cuenta del juego, consultar las zonas existentes y reutilizar la zona pública exacta si ya existe; de lo contrario crearla con `route53 create-hosted-zone`. Guardar su ID sin el prefijo `/hostedzone/` en el parámetro SSM String `/prompt-runner-game/domain/hosted-zone-id`, región `us-east-1`. Conservar los cuatro nameservers asignados por Route53, sin reemplazar sus registros NS o SOA internos.

En la cuenta DNS, revisar los registros existentes del subdominio antes de cambiar nada y crear el único registro de delegación NS `robotrunner.guilleojeda.com` en la zona de `guilleojeda.com`, con esos cuatro nameservers. No cambiar NS, A/AAAA, MX ni otros registros del dominio padre. No duplicar los registros A/AAAA del juego en la zona padre; pertenecen a la zona delegada. Comprobar la delegación contra los nameservers autoritativos y los resolvers públicos antes de publicar el certificado. [Delegación de subdominios de Route53](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/dns-routing-traffic-for-subdomains.html).

Preparar después `PromptRunnerAccess` mediante el procedimiento de acceso siguiente. Su política de dominio autoriza lectura del parámetro SSM, registros en la zona exacta, un certificado de este nombre en `us-east-1` y la función `prompt-runner-game-public-routing`. El certificado y su validación DNS, registros alias y distribución permanecen declarados en `PromptRunnerHosting` y se publican mediante el CI habitual. El operador puede necesitar habilitar temporalmente en el rol de servicio de CloudFormation la lectura del nuevo parámetro y la creación/asociación de la nueva política de Access; revisar el change set y retirar esos permisos temporales después. La política permanente no permite etiquetar certificados ajenos para adoptarlos: las operaciones posteriores exigen el tag de aplicación ya presente. Si el permiso dependiente de tagging durante la primera solicitud del certificado lo requiere, habilitarlo temporalmente sólo durante esa preparación y retirarlo después de verificar el certificado emitido. La cuenta padre no interviene en despliegues posteriores.

## Preparación inicial de AWS

La preparación usa credenciales temporales de operador fuera del repositorio. No se guardan access keys en GitHub. Confirmar primero la identidad y la región; una credencial vencida o de otra cuenta no sirve para preparar este ambiente:

```sh
aws sts get-caller-identity
aws cloudformation describe-stacks --stack-name CDKToolkit --region us-east-1
aws ssm get-parameter --name /cdk-bootstrap/hnb659fds/version --region us-east-1
aws iam list-open-id-connect-providers
gh api repos/guilleojeda/prompt-runner-game/actions/oidc/customization/sub
```

STS debe devolver la cuenta `387483252302`. Revisar un bootstrap existente antes de cambiar sus políticas. Si el proveedor `token.actions.githubusercontent.com` ya existía antes de crear `PromptRunnerAccess`, reutilizar su ARN mediante `GITHUB_OIDC_PROVIDER_ARN` al sintetizar el acceso; no cambiar la confianza de otros repositorios. Si `PromptRunnerAccess` creó el proveedor, mantener su declaración en las actualizaciones del stack, sin convertirlo en una importación que lo elimine del template. Si no existe, el template de preparación lo crea como recurso nativo IAM.

La confianza de este repositorio usa audiencia `sts.amazonaws.com` y subject exacto `repo:guilleojeda@18320860/prompt-runner-game@1373331195:ref:refs/heads/main`. Los identificadores inmutables provienen de la configuración real de GitHub. El job de una PR no recibe permiso `id-token: write` ni puede asumir ese rol.

El acceso inicial se prepara una vez, por separado del stack de hosting; sus políticas se actualizan con el mismo comando de CloudFormation cuando cambian los permisos declarados. Su template crea el rol de GitHub, el rol fijo del publicador de assets y los permisos de ejecución de CloudFormation para hosting, identidad y borradores (HTTP API, Lambda y DynamoDB). Se conserva el nombre físico `prompt-runner-game-phase0-cfn-execution` para mantener su ARN y la asociación con el bootstrap. El bootstrap debe usar esa política explícita; no se utiliza su default `AdministratorAccess`. El stack del hosting importa el rol fijo y no administra los permisos de su propio pipeline.

La descripción física de esa política también conserva el texto inicial: IAM no permite modificarla y CloudFormation intentaría reemplazar el recurso. Su documento de permisos sí se actualiza; la descripción histórica no limita los servicios declarados en ese documento.

Los permisos nuevos de borradores se declaran en una política complementaria de `PromptRunnerAccess`, asociada al mismo rol de ejecución del bootstrap. La política original ya se aproxima al máximo de tamaño de IAM; separarlas evita reemplazar su ARN o recrear el bootstrap. La preparación de acceso actualiza ambas declaraciones y sus asociaciones antes de que main despliegue la aplicación.

AgentCore crea el endpoint predeterminado y una identidad interna junto al Runtime. Antes de asignar sus identificadores, autoriza la creación del endpoint y de la identidad, además del etiquetado, sobre los recursos literales `runtime/*` y `workload-identity-directory/default/workload-identity/*`. Por eso esos permisos de creación usan los ARN de cuenta/región con condiciones `aws:RequestTag/Application=prompt-runner-game` y `aws:RequestedRegion=us-east-1`; un prefijo basado en el nombre futuro no coincide con esos recursos. La creación y el etiquetado de la identidad también requieren el directorio `default`, según la [referencia de autorización de AgentCore](https://docs.aws.amazon.com/service-authorization/latest/reference/list_bedrock-agentcore.html). Las operaciones posteriores conservan los ARN del Runtime propio. Ante una denegación del provider, comprobar la acción y el recurso reales en CloudTrail, incluida la operación interna, antes de cambiar permisos.

Las transacciones DynamoDB se autorizan por sus operaciones internas: `GetItem`, `PutItem`, `UpdateItem` y `ConditionCheckItem` cuando se usan comprobaciones condicionales. `TransactWriteItems` es la operación de API, no un permiso IAM adicional. Los roles de API y ejecutor necesitan esos permisos sobre la tabla retenida; ver [IAM con transacciones DynamoDB](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis-iam.html).

El rol Runtime autoriza únicamente el perfil global de Sonnet 4.6 y sus foundation models de destino exactos; API y starter no reciben permisos de inferencia. Los modelos diferidos no tienen perfiles operativos en Runtime hasta su fase de implementación. El grafo de despliegue ordena el Runtime y sus permisos antes de la Lambda API y la entrada web después de esa Lambda. Se pueden publicar assets estáticos antes sin activar la interfaz nueva.

Un acuerdo de modelo disponible no prueba que la cuenta pueda inferir. Antes de aceptar la ejecución, verificar una llamada real al perfil acordado y la cuota aplicada; una denegación de habilitación de cuenta requiere resolver el acceso con AWS. No se sustituye el modelo para presentar esa verificación como exitosa.

La cuenta AWS es exclusiva de este proyecto. La política permite etiquetar distribuciones de esta cuenta durante su creación, cuando aún no existe el tag `Application`; las operaciones restantes de distribución usan ese tag. OAC y cache policies usan IDs generados y permisos limitados a la cuenta. Estas condiciones asumen esa exclusividad y deben revisarse antes de alojar proyectos ajenos en la misma cuenta.

Después de comprobar la cuenta y los recursos existentes:

```sh
npm run synth
aws cloudformation deploy \
  --stack-name PromptRunnerAccess \
  --template-file cdk.out/PromptRunnerAccess.template.json \
  --capabilities CAPABILITY_NAMED_IAM \
  --region us-east-1
npx cdk bootstrap aws://387483252302/us-east-1 \
  --cloudformation-execution-policies arn:aws:iam::387483252302:policy/prompt-runner-game-phase0-cfn-execution
gh variable set AWS_DEPLOY_ROLE_ARN \
  --repo guilleojeda/prompt-runner-game \
  --body arn:aws:iam::387483252302:role/prompt-runner-game-github-actions-deploy-us-east-1
```

`PromptRunnerAccess` se sintetiza sin assets y se actualiza directamente con CloudFormation, no con `cdk deploy`. El stack existente tiene asociado el rol de servicio `cdk-hnb659fds-cfn-exec-role-387483252302-us-east-1`; CloudFormation conserva esa asociación incluso si la operación la inicia un operador. Para modificar las políticas de Access, el operador habilita temporalmente sólo las acciones IAM y los ARN que requiere el change set revisado, con vencimiento explícito, y retira esa habilitación tras verificar el estado terminal. Las lecturas de los roles existentes necesarias para resolver outputs también deben estar autorizadas. No se agrega administración permanente de Access al pipeline. La variable de GitHub contiene solo un ARN público, y su rol continúa limitado al stack de hosting. `PromptRunnerHosting` se publica desde `main`, nunca mediante este procedimiento manual. Una ampliación de servicios requiere preparar sus permisos declarativos antes de usarlos desde CI.

## Verificación y diagnóstico de publicación

`npm ci` y `npm run check` reproducen los controles de CI. Los pull requests no despliegan. En `main`, el job de publicación depende del éxito de los checks y descarga el Cloud Assembly de ese mismo SHA; publica ese artefacto sin reconstruirlo. Los despliegues de `main` se serializan sin cancelar una actualización en curso.

Para diagnosticar una ejecución, usar su ID en lugar de asumir que el último run corresponde al cambio esperado:

```sh
gh run list --repo guilleojeda/prompt-runner-game --branch main
gh run view RUN_ID --repo guilleojeda/prompt-runner-game --log-failed
aws cloudformation describe-stack-events --stack-name PromptRunnerHosting --region us-east-1
aws cloudformation describe-stacks --stack-name PromptRunnerHosting --region us-east-1
```

El output `WebsiteUrl` entrega `https://robotrunner.guilleojeda.com`; `BuildRevision` identifica la revisión publicada. Compararla con el commit del run y con `document.documentElement.dataset.buildRevision` después de abrir y recargar la web. La carga debe resolver React, CSS y favicon sin errores de consola o red. Un asset inexistente debe devolver un error, y un GET anónimo directo al bucket de origen debe ser rechazado.

Los assets del build vigente se publican antes del documento de entrada. La publicación elimina los objetos que no pertenecen al build actual, así que no se garantiza que una pestaña con una versión anterior siga encontrando sus assets. El HTML y la metadata mutable no se cachean de forma indefinida; una invalidación de CloudFront no reemplaza el control de caché del navegador. No se configura una respuesta HTML general para errores del origen.

Si falla una actualización, conservar el log completo y el estado de CloudFormation antes de reintentar. Corregir el código o la configuración en el mismo circuito de PR, checks y `main`; no publicar manualmente otra copia del frontend para ocultar un fallo del pipeline. Bootstrap, acceso inicial y preparación única de SES son las operaciones preparatorias realizadas con credenciales de operador.

## Comprobaciones de aceptación relevantes

La aceptación del contrato vigente cubre correo Cognito por SES, login, recuperación, reenvío y pertenencia, rutas de admisión/consulta/cancelación, cuota, `principal-puerta-v4`, snapshots, cuerpos privados, preferencia de Animación, reproducción sin inferencia y cierre al cancelar/error. El envío recibido y los códigos se comprueban después de publicar; la síntesis local solo verifica la configuración declarada. La inferencia nativa con Sonnet 4.6, continuidad, cancelación y publicación se comprueban en el ambiente público. Cada cambio revalida el comportamiento que afecte; no se requiere conservar registros o borradores de contratos retirados. La carga amplia queda para una fase posterior. Las pruebas del motor cubren diez tramos, fases periódicas, Esperar, recogida local, puerta cerrada/abierta, salida libre y límite de 24 acciones.

Las lecturas de la cuenta AWS documentan el estado y cuotas efectivos de SES y la identidad configurada. La confirmación de producción y la recepción de los códigos requieren comprobación operativa; los valores predeterminados de Cognito y SES no describen por sí solos la cuota efectiva de esta cuenta.

## Configuración privada de los límites de beta

Los topes de almacenamiento, ejecución, gasto y frecuencia se suministran desde parámetros privados bajo `/prompt-runner-game/limits/`. CloudFormation resuelve parámetros `AWS::SSM::Parameter::Value<String>` con `NoEcho`; la síntesis no consulta sus valores y los assemblies de CI sólo contienen referencias. Los montos, alertas y destinatarios no se guardan en el repositorio ni en la configuración pública de autenticación. Cambiar un parámetro requiere un despliegue para que Lambda y Runtime reciban la nueva configuración. Una configuración ausente o inválida cierra las nuevas operaciones que dependen de ella y mantiene disponibles los datos anteriores.

API Gateway aplica throttling de etapa y tasas específicas para escrituras, admisión y cancelación. Las tasas se ajustan conservando guardado y polling normales; el throttling nativo es best effort. Cognito tiene una ACL regional de AWS WAF que limita por IP los endpoints públicos de registro, confirmación, reenvío y recuperación, tanto API directa como Managed Login. El scope excluye las consultas de identidad y el intercambio de tokens. No depende de un temporizador del navegador.

AWS Budgets envía alertas internas de gasto efectivo para el total mensual de la cuenta y el gasto diario de Bedrock. Los avisos mensuales se reparten entre dos presupuestos de igual alcance para respetar el máximo de cinco avisos por presupuesto. El filtro diario incluye las dimensiones de servicio efectivas de Marketplace del proveedor, además de Bedrock. No hay Budget Actions ni apagado de otros servicios. Los períodos de facturación de AWS y su retraso se distinguen del calendario de Argentina y de la reserva estimada del juego.

Antes de publicar, el operador prepara los parámetros privados y actualiza `PromptRunnerAccess` para habilitar los permisos acotados de SSM, Budgets, WAF y retención. El stage espera a la nueva Lambda antes de actualizar sus tasas, de modo que un cierre temporal de admisión no se levanta antes de publicar la validación nueva. Si Access conserva el rol de ejecución del bootstrap, el operador prepara sólo los permisos IAM acotados para crear y adjuntar la política revisada y leer los atributos necesarios; los elimina al terminar esa preparación. No se amplían de forma permanente sus permisos de creación de políticas. Se comprueba que no queden ejecuciones de la versión anterior sin los nuevos espacios y reservas; si hay alguna, se deja terminar dentro de su vida máxima antes del cambio. La entrega de aplicación sigue el PR, checks y despliegue de main. La verificación publicada lee los valores efectivos privados, las notificaciones y suscriptores, la ACL y la retención de logs, y prueba CountTokens e inferencia desde el Runtime. La plantilla sintetizada sola no acredita estos resultados.
