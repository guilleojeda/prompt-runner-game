# Acceso, publicación y entrega

**Acceso con Cognito y publicación de React estático en S3 privado, servido por CloudFront con Origin Access Control (OAC), mediante CDK en TypeScript y GitHub Actions.** El circuito incorpora el acceso verificado, la configuración persistida, las rutas de intentos y starter/Runtime/S3, con Sonnet 4.6 como único modelo operativo. El nivel principal periódico, la animación opcional y el replay del contrato vigente forman parte del código. Se usa correo predeterminado y un único ambiente; SES se incorporará después. El diseño de animación está en [animación](animacion.md). Las restricciones elegidas por el usuario se mantienen en [plataforma](../intent/plataforma.md); las referencias técnicas están en [identidad](../reference/identidad.md), [datos y entrega](../reference/datos-y-entrega.md) y [cuenta AWS](../reference/cuenta-aws.md).

## Primera versión: Cognito con correo predeterminado

Se usa **Cognito Essentials con Managed Login en español, email y contraseña, confirmación por código y recuperación administrada**. React inicia Authorization Code con PKCE y un app client público sin secreto, solicitando `lang=es`. Antes de jugar, cada usuario debe confirmar que tiene acceso a su casilla.

El pool se configura con **`EmailSendingAccount=COGNITO_DEFAULT`**, remitente administrado `no-reply@verificationemail.com` y sin `SourceArn` ni emisor propio. La primera versión no depende de habilitar SES en producción, verificar un dominio de correo o desarrollar una Lambda de envío. Los recursos de correo subyacentes son administrados por Cognito.

Se aceptan inicialmente estas condiciones del servicio:

- **50 emails diarios no ajustables**, compartidos por las operaciones de envío, con reinicio publicado a las 09:00 UTC. La discrepancia documental sobre alcance cuenta/pool se conserva en [la referencia](../reference/identidad.md); no se presume capacidad adicional por crear pools.
- El límite incluye altas, reenvíos y recuperación. El acceso normal con contraseña no requiere otro email. Esta cuota de correo es independiente de los cien intentos diarios por usuario y de los cien usuarios simultáneos del juego.
- Se usan **mensajes estándar de Cognito**, sin personalizar asunto o cuerpo. Managed Login y la aplicación están en español; la primera versión no exige traducir los correos estándar.
- Si el proveedor impide un envío por cuota o por error, se informa el impedimento y se permite reintentar cuando corresponda. Un alta puede haber dejado un usuario `UNCONFIRMED`; se conserva ese estado y se ofrece reenvío, sin marcar la casilla como verificada para sortear el límite.

La cuenta actual obtiene su identidad desde `userInfo` de Cognito con los scopes `openid email`; solo se habilita después de validar el email verificado y la identidad de la sesión. No necesita una API propia ni guarda perfiles duplicados. Las contraseñas y los códigos de recuperación se ingresan en Cognito. Si se abandonó la confirmación del registro, la aplicación ofrece una pantalla de email y código para retomarla: llama directamente a las APIs públicas `ResendConfirmationCode` y `ConfirmSignUp` del mismo pool y cliente. Se puede usar un código ya recibido sin reenviar primero. No guarda el código ni autentica por confirmar; después se inicia el ingreso normal con OAuth y se valida UserInfo.

Esta pantalla cubre una limitación de Managed Login: Cognito no ofrece una entrada directa soportada para volver a confirmar una cuenta pendiente después de abandonar su flujo. `/confirm` y `/resendcode` son rutas de redirección internas, por lo que no se construyen enlaces basados en sus parámetros internos. [Endpoints administrados de Cognito](https://docs.aws.amazon.com/cognito/latest/developerguide/managed-login-endpoints.html).

El backend usa el authorizer JWT de HTTP API, con issuer/cliente y scope `prompt-runner/robot` en `/draft` y en las rutas de intentos. Lambda exige un access token del cliente esperado y valida UserInfo con email verificado y sub coincidente antes de acceder a datos. El sub validado determina las claves de borrador, solicitud, intento y cuota; no se acepta otro propietario como selector. La guarda de la pantalla no sustituye esa autorización de servidor; un JWT tampoco autoriza leer cualquier identificador.

### Sesión del navegador

El cliente público usa `oidc-client-ts` para Code Grant con PKCE S256 y validación de la transacción. El callback y el retorno de logout son `/`, por lo que la autenticación no necesita rutas nuevas ni un fallback de errores a HTML. La configuración pública se carga de `/auth-config.json`: contiene issuer, client ID, dominio, URLs de retorno, `apiBaseUrl` y `apiScope`, nunca un secreto de cliente. CDK resuelve esos valores al publicar el assembly verificado, sin reconstruir React después del despliegue.

Los tokens y la transacción OAuth se conservan en `sessionStorage`. La recarga puede recuperar la sesión de esa pestaña, pero debe validar la identidad con Cognito antes de mostrar la cuenta. Si el access token venció, se intenta renovarlo con un refresh token válido; si la sesión ya no sirve, se pide un nuevo ingreso. Una falla transitoria ofrece reintentar y no habilita acceso a partir de un perfil viejo.

El cliente conserva las duraciones predeterminadas de Cognito: access token e ID token de una hora, refresh token de 30 días y ventana del desafío de autenticación (`AuthSessionValidity`) de tres minutos. Esta última no limita la duración de la sesión web. Los tokens emitidos confirman la duración de una hora; `DescribeUserPoolClient` informa las otras dos duraciones. La caducidad del access token permite renovar la sesión con un refresh válido; no obliga a volver a ingresar mientras esa renovación funcione. [Duraciones y unidades de Cognito](https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_CreateUserPoolClient.html).

Cerrar sesión elimina el estado local, revoca el refresh token y navega al endpoint `/logout` de Cognito para cerrar también su cookie. Una falla remota no vuelve a abrir la cuenta local y se informa al usuario. No se promete cerrar sesiones de otros dispositivos. Al abrir otra pestaña o navegador sin estado local, la persona vuelve por Managed Login y mantiene su misma cuenta e identificador.

## Acceso a la configuración del robot

El cliente solicita `openid email prompt-runner/robot`. El resource server Cognito y el scope se administran con CDK dentro del mismo pool/cliente. Una sesión emitida antes de incorporar ese scope debe volver por Managed Login; renovar un token no se usa para conceder permisos nuevos. La cuenta y su sub se conservan.

Las solicitudes a la API envían el access token en Authorization, no el ID token, cookies ni parámetros de URL. CORS permite sólo el origen HTTPS de CloudFront y el origen local de desarrollo, con GET/PUT/POST/OPTIONS y Authorization/Content-Type. Las respuestas del borrador no se cachean. El acceso a UserInfo desde Lambda conserva la exigencia de email verificado también cuando se llama a la API fuera de React; sus errores transitorios no autorizan una lectura o escritura por defecto.

El editor conserva sus cambios pendientes en memoria mientras renueva la misma identidad y pausa las escrituras hasta validar la sesión. Cerrar sesión o cambiar de cuenta invalida las operaciones del editor anterior, incluidas respuestas tardías. No hay una copia persistente del borrador en el navegador, salvo el snapshot transitorio de una admisión ya iniciada: después de **Probar**, `sessionStorage` puede conservar la clave, versión, `animationEnabled` y payload exactos hasta confirmar o descartar esa admisión. También conserva el identificador de un intento admitido mientras su presentación está pendiente para recuperarla tras recargar. No funciona como preferencia ni como borrador alternativo y se elimina al cerrar sesión o cambiar de cuenta. [Concurrencia y recuperación del guardado](datos.md#borrador-disponible).

La API registra un resultado estructurado por solicitud en su log de Lambda: `requestId`, método, estado HTTP y código de resultado. Ese identificador permite correlacionar el error sin registrar el bearer, el borrador ni los detalles privados de las excepciones de dependencias.

### Rutas de ejecución y reproducción

Con la misma autenticación se declaran `POST /attempts`, `GET /attempt-requests/{requestKey}`, `GET /attempts/{attemptId}`, `GET /attempts?cursor=...`, `POST /attempts/{attemptId}/start`, `POST /attempts/{attemptId}/cancel`, `GET /attempts/{attemptId}/replay`, `POST /attempts/{attemptId}/presentation-complete`, `GET/PUT /animation-preference` y `GET /quota`. La interfaz usa `requestKey` para recuperar una admisión ambigua; no usa el navegador como autoridad del intento. El valor vigente de Animación se fija en cada admisión y la preferencia usa versión para resolver cambios entre pestañas. El replay devuelve sólo la proyección pública del registro cerrado, después de comprobar pertenencia. No hay una ruta pública para Runtime, bodies, diagnóstico ni ranking.

## Fase posterior: correo propio con SES

Después de contar con la versión funcional con Cognito, se incorporará **SES como mecanismo de envío del mismo user pool**. Esa fase comprende verificar un emisor, habilitar producción para destinatarios arbitrarios, configurar permisos y `EmailSendingAccount=DEVELOPER`, y definir mensajes de confirmación y recuperación en español. Se comprobarán envío real, reenvío, recuperación y cuotas aplicables.

El cambio conserva user pool, usuarios, sus identificadores y la relación con configuraciones e intentos. Es una actualización del envío, no una migración de cuentas. La configuración declarativa debe actualizar el pool existente sin reemplazarlo; la primera versión no incorpora una abstracción de proveedores ni componentes de SES sin usar. El remitente propio se definirá al preparar esa fase y no bloquea la versión inicial.

## Fundamento

El correo predeterminado reduce la preparación y permite completar primero el acceso real. SES posterior mantiene identidad e infraestructura en AWS y permite personalizar mensajes y superar el límite del envío predeterminado con la integración nativa.

Cognito con Resend también evita solicitar producción SES, pero añade una Lambda de envío, KMS, credenciales externas y un dominio verificado. Firebase cambia el proveedor de identidad; el acceso exclusivamente federado modifica las condiciones de registro. Se conserva el fundamento de usar Cognito y luego SES; las capacidades de esas alternativas están en [identidad y correo](../reference/identidad.md).

## Frontend y publicación

El hosting usa **React estático en un bucket S3 privado, servido por CloudFront mediante Origin Access Control (OAC)**. El build y la publicación de assets y configuración se ejecutan con GitHub Actions y CDK en TypeScript. Se utiliza la URL AWS, sin dominio propio. La única ruta de la entrada inicial es `/`; se puede recargar y no existe una redirección general de errores a HTML. Al agregar rutas de la SPA se incorporará su recarga sin convertir errores de assets o API en una respuesta HTML exitosa.

El renderer utiliza React y sprites dentro de SVG, a partir de registros cerrados del contrato vigente y un único reloj de reproducción. El [diseño de animación](animacion.md) define clips, trayectorias y carga, con avance continuo a velocidad fija y sin controles del usuario; CSS se usa para estilos y no como un reloj independiente. El juego muestra estado, resultado, historial y replay sin ejecutar física en el navegador. El diagnóstico técnico permanece para una fase posterior.

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

La [URL pública del frontend](https://d1ilpq1n58tzqo.cloudfront.net) ofrece el ambiente público conocido para acceso, cuenta, preparación del robot y ejecución del juego. El ambiente está en la cuenta `387483252302`, región `us-east-1`:

| Recurso                 | Identificador                                              |
| ----------------------- | ---------------------------------------------------------- |
| Acceso inicial          | Stack `PromptRunnerAccess`                                 |
| Bootstrap CDK           | Stack `CDKToolkit`, qualifier `hnb659fds`                  |
| Hosting                 | Stack `PromptRunnerHosting`                                |
| Distribución CloudFront | `E121DZBSJ73SOP`                                           |
| Origen privado          | Bucket `prompt-runner-game-website-387483252302-us-east-1` |

La preparación ya está hecha. Para una actualización habitual, abrir una PR, esperar sus checks e integrar a `main`; Actions publica el assembly verificado. Solo los cambios de permisos requieren actualizar primero `PromptRunnerAccess` con acceso temporal de operador, siguiendo el procedimiento siguiente.

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

El output `WebsiteUrl` entrega la URL HTTPS de CloudFront; `BuildRevision` identifica la revisión publicada. Compararla con el commit del run y con `document.documentElement.dataset.buildRevision` después de abrir y recargar la web. La carga debe resolver React, CSS y favicon sin errores de consola o red. Un asset inexistente debe devolver un error, y un GET anónimo directo al bucket de origen debe ser rechazado.

Los assets del build vigente se publican antes del documento de entrada. La publicación elimina los objetos que no pertenecen al build actual, así que no se garantiza que una pestaña con una versión anterior siga encontrando sus assets. El HTML y la metadata mutable no se cachean de forma indefinida; una invalidación de CloudFront no reemplaza el control de caché del navegador. No se configura una respuesta HTML general para errores del origen.

Si falla una actualización, conservar el log completo y el estado de CloudFormation antes de reintentar. Corregir el código o la configuración en el mismo circuito de PR, checks y `main`; no publicar manualmente otra copia del frontend para ocultar un fallo del pipeline. Bootstrap y acceso inicial son las únicas operaciones preparatorias realizadas con credenciales de operador.

## Comprobaciones de aceptación relevantes

La aceptación del contrato vigente cubre correo predeterminado, login, recuperación, pertenencia, rutas de admisión/consulta/cancelación, cuota, `principal-recompensas-v3`, snapshots, cuerpos privados, preferencia de Animación, reproducción sin inferencia y cierre al cancelar/error. La inferencia nativa con Sonnet 4.6, continuidad, cancelación y publicación se comprueban en el ambiente público. Cada cambio revalida el comportamiento que afecte; no se requiere conservar registros o borradores de contratos retirados. La carga amplia queda para una fase posterior. Las pruebas del motor cubren las siete secciones, las fases periódicas, Esperar, la recogida local y el límite de 16 acciones.

Las lecturas de Lambda y Bedrock identifican preparación pendiente. La primera versión verifica la entrega real con Cognito y sus límites aceptados; la habilitación de SES y el emisor propio pertenecen a la fase posterior. No se condiciona la versión inicial a tener SES en producción.
