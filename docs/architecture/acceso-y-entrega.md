# Acceso, publicación y entrega

**Publicación implementada: React estático en S3 privado, servido por CloudFront con Origin Access Control (OAC), publicado por CDK en TypeScript y GitHub Actions.** La entrada actual es mínima; Cognito, el juego y su renderer siguen pendientes. Cognito con correo predeterminado y un único ambiente están aprobados; SES se incorporará después. El renderer y el flujo de animación se definen en [animación](animacion.md). Las restricciones elegidas por el usuario se mantienen en [plataforma](../intent/plataforma.md); las referencias técnicas están en [identidad](../reference/identidad.md), [datos y entrega](../reference/datos-y-entrega.md) y [cuenta AWS](../reference/cuenta-aws.md).

## Primera versión: Cognito con correo predeterminado

Se usa **Cognito Essentials con Managed Login en español, email y contraseña, confirmación por código y recuperación administrada**. React inicia Authorization Code con PKCE y un app client público sin secreto, solicitando `lang=es`. Antes de jugar, cada usuario debe confirmar que tiene acceso a su casilla.

El pool se configura con **`EmailSendingAccount=COGNITO_DEFAULT`**, remitente administrado `no-reply@verificationemail.com` y sin `SourceArn` ni emisor propio. La primera versión no depende de habilitar SES en producción, verificar un dominio de correo o desarrollar una Lambda de envío. Los recursos de correo subyacentes son administrados por Cognito.

Se aceptan inicialmente estas condiciones del servicio:

- **50 emails diarios no ajustables**, compartidos por las operaciones de envío, con reinicio publicado a las 09:00 UTC. La discrepancia documental sobre alcance cuenta/pool se conserva en [la referencia](../reference/identidad.md); no se presume capacidad adicional por crear pools.
- El límite incluye altas, reenvíos y recuperación. El acceso normal con contraseña no requiere otro email. Esta cuota de correo es independiente de los cien intentos diarios por usuario y de los cien usuarios simultáneos del juego.
- Se usan **mensajes estándar de Cognito**, sin personalizar asunto o cuerpo. Managed Login y la aplicación están en español; la primera versión no exige traducir los correos estándar.
- Si el proveedor impide un envío por cuota o por error, se informa el impedimento y se permite reintentar cuando corresponda. Un alta puede haber dejado un usuario `UNCONFIRMED`; se conserva ese estado y se ofrece reenvío, sin marcar la casilla como verificada para sortear el límite.

La API usa el authorizer JWT de HTTP API, con issuer/cliente y scope de aplicación explícitos para usar access tokens. Cada operación obtiene el `sub` validado y comprueba propiedad de configuraciones e intentos. El JWT por sí solo no autoriza leer cualquier identificador. La confirmación de email sigue siendo necesaria y no se reemplaza por validar la sintaxis de la dirección.

## Fase posterior: correo propio con SES

Después de contar con la versión funcional con Cognito, se incorporará **SES como mecanismo de envío del mismo user pool**. Esa fase comprende verificar un emisor, habilitar producción para destinatarios arbitrarios, configurar permisos y `EmailSendingAccount=DEVELOPER`, y definir mensajes de confirmación y recuperación en español. Se comprobarán envío real, reenvío, recuperación y cuotas aplicables.

El cambio conserva user pool, usuarios, sus identificadores y la relación con configuraciones e intentos. Es una actualización del envío, no una migración de cuentas. La configuración declarativa debe actualizar el pool existente sin reemplazarlo; la primera versión no incorpora una abstracción de proveedores ni componentes de SES sin usar. El remitente propio se definirá al preparar esa fase y no bloquea la versión inicial.

## Fundamento

El correo predeterminado reduce la preparación y permite completar primero el acceso real. SES posterior mantiene identidad e infraestructura en AWS y permite personalizar mensajes y superar el límite del envío predeterminado con la integración nativa.

Cognito con Resend también evita solicitar producción SES, pero añade una Lambda de envío, KMS, credenciales externas y un dominio verificado. Firebase cambia el proveedor de identidad; el acceso exclusivamente federado modifica las condiciones de registro. Se conserva el fundamento de usar Cognito y luego SES; las capacidades de esas alternativas están en [identidad y correo](../reference/identidad.md).

## Frontend y publicación

El hosting usa **React estático en un bucket S3 privado, servido por CloudFront mediante Origin Access Control (OAC)**. El build y la publicación de assets y configuración se ejecutan con GitHub Actions y CDK en TypeScript. Se utiliza la URL AWS, sin dominio propio. La única ruta de la entrada inicial es `/`; se puede recargar y no existe una redirección general de errores a HTML. Al agregar rutas de la SPA se incorporará su recarga sin convertir errores de assets o API en una respuesta HTML exitosa.

El renderer aprobado utiliza React y sprites dentro de SVG, a partir de registros cerrados y un único reloj de reproducción. El [diseño de animación](animacion.md) define clips, trayectorias, fases, carga y compatibilidad, con avance continuo a velocidad fija y sin controles del usuario; CSS se usa para estilos y no como un reloj independiente. No requiere motor de física del navegador, SSR ni video prerenderizado. El diagnóstico técnico se abre aparte; no se requiere editar JSON para jugar.

La interfaz tiene una única acción Probar: guarda el borrador actual y bloquea los controles de configuración y nuevos intentos. La opción Animación se fija en ese clic. Al terminar el cálculo, la UI anima y luego muestra el resultado si estaba encendida; si estaba apagada pasa directamente al resultado. No se muestran métricas o historial del intento nuevo durante su animación. El resultado libera el editor. Ambas rutas mantienen guardado e inspección completos, según [experiencia](../intent/experiencia.md).

Amplify Hosting también podría definirse con CDK y recibir publicaciones desde GitHub Actions mediante su API. Ofrece hosting y previews administrados, pero esas capacidades no están pedidas y añadirían un circuito de publicación diferente al backend CDK. S3/CloudFront mantiene una forma uniforme de entregar esta SPA y es la decisión aprobada. No se extrapola un costo mensual sin uso.

El bucket del frontend es privado y se sirve exclusivamente a través de CloudFront con OAC. El bucket de cuerpos de inferencia también es privado e independiente del bucket del frontend. Los logs operativos registran IDs, transiciones y errores; no duplican por defecto prompts, cuerpos ni tokens de autenticación. El registro completo del producto permanece en su almacenamiento autorizado y sin caducidad automática.

## Entrega automática y ambientes

La primera versión usa **un único ambiente desplegado**, en la cuenta y región elegidas. Esta decisión minimiza configuración de identidad, callbacks, Runtime y recursos. Las verificaciones reales posteriores al despliegue ocurren en el ambiente público y una regresión de integración puede llegar a participantes antes de detectarse. Las pruebas usan usuarios y datos propios identificables; no alteran historiales ajenos.

Separar prueba y público permitiría verificar integración antes de promover los mismos artefactos al público, pero duplica configuración, recursos retenidos y ejecuciones de comprobación. Para la primera versión se elige la menor carga operativa de un ambiente; se conserva la consecuencia sobre la exposición a regresiones como fundamento de esa decisión.

El circuito de entrega es:

- Pull requests ejecutan instalación reproducible, tipos, pruebas pertinentes, build y validación/synth CDK, sin credenciales de despliegue.
- `main` vuelve a verificar y despliega automáticamente por GitHub Actions. Los despliegues se serializan sin cancelar uno que esté actualizando recursos.
- GitHub obtiene credenciales temporales con OIDC; la confianza restringe repositorio y rama/environment según los claims reales. No se guardan claves AWS permanentes.
- Los roles del runtime, API y arranque tienen permisos por responsabilidad. El agente solo accede a inferencia y datos de aplicación necesarios; no recibe credenciales ni herramientas de despliegue.
- Los recursos de datos e identidad se conservan ante despliegues o reemplazos rutinarios. Los formatos de registros se versionan; un lector nuevo debe poder reproducir los registros retenidos.
- Las comprobaciones posteriores al despliegue vinculan versión de código y entorno con acceso real, inferencia, persistencia y replay. Un rollback de código no borra usuarios o intentos ni sustituye la compatibilidad de datos.

## Preparación inicial de AWS

La preparación usa credenciales temporales de operador fuera del repositorio. No se guardan access keys en GitHub. Confirmar primero la identidad y la región; una credencial vencida o de otra cuenta no sirve para preparar este ambiente:

```sh
aws sts get-caller-identity
aws cloudformation describe-stacks --stack-name CDKToolkit --region us-east-1
aws ssm get-parameter --name /cdk-bootstrap/hnb659fds/version --region us-east-1
aws iam list-open-id-connect-providers
gh api repos/guilleojeda/prompt-runner-game/actions/oidc/customization/sub
```

STS debe devolver la cuenta `387483252302`. Revisar un bootstrap existente antes de cambiar sus políticas. Si ya existe el proveedor `token.actions.githubusercontent.com`, reutilizar su ARN mediante `GITHUB_OIDC_PROVIDER_ARN` al sintetizar el acceso; no cambiar la confianza de otros repositorios. Si no existe, el template de preparación lo crea como recurso nativo IAM.

La confianza de este repositorio usa audiencia `sts.amazonaws.com` y subject exacto `repo:guilleojeda@18320860/prompt-runner-game@1373331195:ref:refs/heads/main`. Los identificadores inmutables provienen de la configuración real de GitHub. El job de una PR no recibe permiso `id-token: write` ni puede asumir ese rol.

El acceso inicial se prepara una vez, por separado del stack de hosting. Su template crea el rol de GitHub, el rol fijo del publicador de assets y la política de ejecución de CloudFormation limitada a este frontend. El bootstrap debe usar esa política explícita; no se utiliza su default `AdministratorAccess`. El stack del hosting importa el rol fijo y no administra los permisos de su propio pipeline.

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

`PromptRunnerAccess` se sintetiza sin depender del bootstrap ni de assets. Desplegarlo directamente con CloudFormation evita que la preparación dependa del rol que todavía debe crear. La variable de GitHub contiene solo un ARN público. La aplicación `PromptRunnerHosting` se publica posteriormente desde `main`, nunca mediante este procedimiento manual. Una ampliación futura de servicios requiere actualizar declarativamente la política de preparación antes de usar esos permisos desde CI.

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

Los assets con hash se conservan para que una pestaña abierta siga resolviendo su build. Se publican antes del documento de entrada. El HTML y la metadata mutable no se cachean de forma indefinida; una invalidación de CloudFront no reemplaza el control de caché del navegador. No se configura una respuesta HTML general para errores del origen.

Si falla una actualización, conservar el log completo y el estado de CloudFormation antes de reintentar. Corregir el código o la configuración en el mismo circuito de PR, checks y `main`; no publicar manualmente otra copia del frontend para ocultar un fallo del pipeline. Bootstrap y acceso inicial son las únicas operaciones preparatorias realizadas con credenciales de operador.

## Comprobaciones de aceptación relevantes

En la primera versión se verifica registro real con correo predeterminado recibido, confirmación, login, recuperación, interfaz en español y manejo del límite de correo sin omitir la verificación; pertenencia con dos usuarios; cuota concurrente y su horario; frontend desplegado que sobrevive recarga; cierre del navegador durante un intento; y recuperación de su replay sin modelo. Las pruebas del motor cubren todas las reglas acordadas, incluidos últimos turnos, fases y ambos sentidos de movimiento. La evidencia debe incluir inferencia real del endpoint elegido y ejecución hasta el pico acordado con un patrón de carga explícito, sin asumir que las cuotas actuales lo permiten.

Las lecturas de Lambda y Bedrock identifican preparación pendiente. La primera versión verifica la entrega real con Cognito y sus límites aceptados; la habilitación de SES y el emisor propio pertenecen a la fase posterior. No se condiciona la versión inicial a tener SES en producción.
