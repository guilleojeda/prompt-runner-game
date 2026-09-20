# Referencia técnica: identidad y correo

Consulta de fuentes oficiales: **16–20 de septiembre de 2026**. La decisión vigente es Cognito con correo predeterminado en la primera versión y SES propio en una fase posterior, según [acceso y entrega](../architecture/acceso-y-entrega.md). La implementación actual y sus condiciones de acceso se describen en el documento de arquitectura. El producto exige registro abierto y control del email según [plataforma](../intent/plataforma.md).

## Registro y acceso en Cognito

| Modalidad | Contrato publicado |
|---|---|
| Email y contraseña | `SignUp` crea el usuario; con verificación automática de email, queda `UNCONFIRMED` y recibe un código. `ConfirmSignUp` con el código confirma el usuario y el atributo. |
| Registro sin contraseña | `SignUp` puede omitir `Password` cuando pool y cliente habilitan passwordless, se proporcionan los atributos correspondientes y se usa una interfaz propia mediante API/SDK. |
| Login con email OTP | Usa `USER_AUTH`, factor `EMAIL_OTP` y respuestas al challenge; requiere Essentials o Plus y configuración SES propia. |
| Páginas administradas | Ofrecen registro, acceso, recuperación y verificación. La página de registro administrada todavía exige contraseña, aunque se habiliten factores passwordless para el acceso. |

Fuentes: [registro y confirmación](https://docs.aws.amazon.com/cognito/latest/developerguide/signing-up-users-in-your-app.html), [SignUp](https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_SignUp.html), [flujos](https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-authentication-flow-methods.html), [planes](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-sign-in-feature-plans.html).

Managed Login solo ofrece la confirmación y el reenvío dentro de la transacción de registro: `/confirm` recibe una redirección desde `/signup` y `/resendcode` desde esa confirmación. No son entradas directas soportadas para retomar una cuenta pendiente tras abandonar el flujo. La aplicación usa las APIs públicas de reenvío y confirmación para cubrir esa continuidad. [Endpoints de Managed Login](https://docs.aws.amazon.com/cognito/latest/developerguide/managed-login-endpoints.html).

Las operaciones públicas de registro y autenticación no requieren credenciales IAM. Las variantes administrativas sí. Si el app client tiene secreto, interviene `SecretHash`; eso pertenece a un cliente confidencial, no a un secreto que pueda publicarse en React. AWS SDK JavaScript v3 expone las operaciones de registro, confirmación y challenge. [Modelo de autorización](https://docs.aws.amazon.com/cognito/latest/developerguide/authentication-flows-public-server-side.html), [SDK](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/cognito-identity-provider).

### Precisión sobre email verificado

El código de confirmación de registro comprueba control de la casilla; el código tiene vigencia documentada de 24 horas. No se debe confundir confirmación de usuario con una simple validación sintáctica de email. [ConfirmSignUp](https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_ConfirmSignUp.html).

Los ejemplos de login OTP usan un email verificado como destino elegible. La misma documentación indica que completar un OTP puede verificar un atributo inicialmente no verificado y confirmar un usuario; no publica una matriz completa de estados que puedan iniciar directamente el challenge ordinario. Las rutas de registro/confirmación y email MFA tienen condiciones distintas. No convertir esa explicación general en una garantía para cualquier usuario `UNCONFIRMED`. [Flujos](https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-authentication-flow-methods.html), [email MFA](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-settings-mfa-sms-email-message.html).

## Interfaz en español

Classic Hosted UI admite personalización limitada de logo/CSS, pero el parámetro `lang` no traduce sus páginas. Managed Login admite español mediante `lang=es` y mantiene la preferencia durante la navegación mediante cookie. Requiere Essentials o Plus y branding Managed Login. La localización de páginas no garantiza traducir automáticamente mensajes de triggers personalizados de correo. [Managed Login](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-managed-login.html), [endpoint de autorización](https://docs.aws.amazon.com/cognito/latest/developerguide/authorization-endpoint.html), [branding clásico](https://docs.aws.amazon.com/cognito/latest/developerguide/hosted-ui-classic-branding.html).

**Implicación:** las interfaces administradas difieren tanto en idioma como en registro passwordless. Que un plan permita OTP no demuestra que su página administrada permita crear una cuenta sin contraseña. La opción elegida usa Managed Login con email y contraseña, confirmación por código y correo predeterminado inicialmente.

## Modalidades de envío de correo

| Configuración | Requisitos y límites publicados |
|---|---|
| `COGNITO_DEFAULT`, remitente estándar | Usa `no-reply@verificationemail.com` y recursos administrados por AWS; sin `SourceArn` no necesita una identidad SES propia ni sacar esa cuenta del sandbox. Sirve para confirmar registros con email y contraseña. |
| `COGNITO_DEFAULT`, remitente propio | Requiere identidad SES verificada y autorización de envío para Cognito. |
| `DEVELOPER` | Usa una identidad SES propia, permisos y service-linked role. El envío a destinatarios arbitrarios requiere producción en SES. |
| OTP por email como primer factor | La tabla Cognito exige SES propio y plan Essentials o Plus. |

Fuentes: [email en Cognito](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-email.html), [salida del sandbox](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html).

Para un pool en `us-east-1`, la documentación admite identidades SES de `us-east-1`, `us-west-2` o `eu-west-1`, con verificación y configuración regional correspondientes. No admite reutilizar una identidad SES de otra cuenta. La creación de la configuración `DEVELOPER` puede necesitar `iam:CreateServiceLinkedRole`. [Configuración Cognito/SES](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-email.html).

El sandbox SES publica 200 destinatarios por 24 horas y uno por segundo, restringidos a destinos verificados o al simulador. El emisor propio debe verificarse también al salir del sandbox. El envío predeterminado de Cognito publica **50 emails diarios, no ajustables**, con reinicio a las **09:00 UTC**. La página de cuotas dice por cuenta AWS y explica el alcance cuenta/región, mientras email settings y CloudFormation hablan de user pool. Se conserva esa discrepancia: no se promete multiplicar capacidad creando pools. [Cuotas SES](https://docs.aws.amazon.com/ses/latest/dg/quotas.html), [cuotas Cognito](https://docs.aws.amazon.com/cognito/latest/developerguide/quotas.html), [EmailConfiguration de CloudFormation](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-cognito-userpool-emailconfiguration.html).

El límite incluye correos de alta, reenvío, recuperación, verificación de atributos e invitaciones. Confirmar el código o entrar normalmente con contraseña no envía otro correo. Por tanto, cien usuarios simultáneos no equivalen a cien emails diarios: importa cuántos eventos de envío ocurren. [Operaciones que generan correo](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-email.html).

Al agotarse una cuota de envío, `SignUp` puede devolver `LimitExceeded` y haber creado igualmente un usuario `UNCONFIRMED`. La aplicación debe permitir reenvío posterior, sin confirmar una casilla que no demostró acceso. Las APIs de reenvío y recuperación documentan errores de límite y entrega; el agotamiento diario real devolvió `LimitExceededException` en la API de reenvío. No se determinó si un envío fallido consume cuota. [SignUp](https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_SignUp.html), [ResendConfirmationCode](https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_ResendConfirmationCode.html), [ForgotPassword](https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_ForgotPassword.html).

El estado efectivo del entorno está en [cuenta AWS](cuenta-aws.md). El sandbox de esa cuenta afecta SES propio; no implica que toda modalidad de correo Cognito esté bloqueada.

### Idioma y cambio posterior del remitente

`VerificationMessageTemplate.DefaultEmailOption` permite elegir código o enlace. Sin embargo, los campos de asunto y cuerpo —`EmailMessage`, `EmailSubject` y sus variantes de enlace— solo se pueden configurar con `EmailSendingAccount=DEVELOPER`. Los campos antiguos `EmailVerificationMessage` y `EmailVerificationSubject` están documentados como no utilizados. No hay una vía declarativa documentada para imponer textos españoles en `COGNITO_DEFAULT`; `lang=es` localiza Managed Login y no acredita el idioma del correo recibido. [Plantilla de verificación](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-cognito-userpool-verificationmessagetemplate.html), [UserPool](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-cognito-userpool.html).

Cambiar a SES propio se configura sobre el mismo pool mediante `EmailConfiguration`. CloudFormation marca esa propiedad como actualización sin interrupción; el cambio no requiere reemplazar el pool ni recrear usuarios. Es una capacidad documentada, no una migración ejecutada aquí. La nueva configuración necesita emisor verificado, permisos y acceso de producción para destinos arbitrarios. [UpdateUserPool](https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_UpdateUserPool.html), [UserPool de CloudFormation](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-cognito-userpool.html), [SES sandbox](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html).

## Alternativas sin SES propio en producción

### Cognito con un proveedor externo de correo

`CustomEmailSender` reemplaza el envío de Cognito por una Lambda que recibe los códigos cifrados, los descifra con AWS Encryption SDK y una clave KMS administrada por el cliente, y entrega todos los correos mediante el proveedor elegido. Se conservan Cognito y su verificación de códigos; se añade la integración de envío, sus permisos y la credencial del proveedor. Es distinto del trigger `CustomMessage`, que personaliza mensajes pero no reemplaza al emisor. [Custom sender](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-lambda-custom-sender-triggers.html), [Custom email sender](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-lambda-custom-email-sender.html).

**Resend** documenta acceso de producción inmediato, incluso en cuentas gratuitas, sin solicitud de aprobación. Para enviar a destinatarios distintos de la propia cuenta requiere verificar un dominio mediante DNS; el dominio de pruebas `resend.dev` no sirve para registro abierto. [Acceso de producción](https://resend.com/docs/knowledge-base/does-resend-require-production-approval), [restricción del dominio de pruebas](https://resend.com/docs/knowledge-base/403-error-resend-dev-domain).

El plan gratuito publica **100 emails/día y 3.000/mes**. Pro publica **USD 20/mes por 50.000 emails**, sin límite diario; siguen existiendo límites de API y reglas del servicio. A esos importes se agregan Cognito, Lambda y KMS aplicables. No se creó cuenta ni se verificó un dominio. [Cuotas Resend](https://resend.com/docs/knowledge-base/account-quotas-and-limits), [precios](https://resend.com/pricing/).

### Otro proveedor de identidad

**Firebase Authentication** permite email/contraseña y `sendEmailVerification`, con localización del mensaje y un handler de verificación administrado por defecto. No exige configurar SES ni SMTP propio. En Spark publica 1.000 emails de verificación/día y 150 de recuperación/día; el límite de 5 emails/día para acceso por enlace corresponde a otro flujo. [Gestión de usuarios](https://firebase.google.com/docs/auth/web/manage-users), [handler de acciones](https://firebase.google.com/docs/auth/custom-email-handler), [límites](https://firebase.google.com/docs/auth/limits).

Adoptarlo mantiene la aplicación de juego en AWS, pero mueve identidad y correo a Firebase y requiere integrar la interfaz de acceso y la validación de sus ID tokens en el backend, incluido exigir email verificado. La verificación de firma, emisor, audiencia y expiración está documentada; no se probó esa integración en Lambda ni su aprovisionamiento desde el pipeline del proyecto. [Verificar ID tokens](https://firebase.google.com/docs/auth/admin/verify-id-tokens). La arquitectura elegida conserva Cognito; estos hechos describen la alternativa, no una elección pendiente.

Auth0 no elimina automáticamente la configuración del correo: su proveedor incorporado está destinado a pruebas, no permite plantillas propias y documenta 10 emails/minuto; para producción pide un proveedor externo. No se propone reemplazar Cognito por ese motivo. [Proveedor de correo Auth0](https://auth0.com/docs/customize/email/smtp-email-providers).

### Acceso federado

Cognito admite Google como proveedor social y el mapeo de `email_verified`. Usarlo como único acceso evita que el juego envíe una confirmación local, pero exige una cuenta en ese proveedor y cambia el alcance de registro por email. Además, Google distingue direcciones Gmail/Workspace, donde es autoridad, de cuentas Google con email externo, cuya propiedad pudo cambiar después de la verificación inicial. No se asume que agregar login Google resuelva la verificación de cualquier casilla. [Google en Cognito](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-social-idp.html), [mapeo de atributos](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-specifying-attribute-mapping.html), [autoridad sobre el email](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token).

## CDK, CloudFormation y tokens

CloudFormation/CDK documentan user pool, app client, dominio, branding, factores de autenticación, verificación automática y configuración de email. SES dispone de un recurso declarativo de identidad. La biblioteca L2 y la API no siempre muestran idénticas restricciones: `AllowedFirstAuthFactors` en CDK declara `password` obligatorio/verdadero, mientras la API muestra ejemplos solo OTP. Esa diferencia queda pendiente para la versión concreta que se use; no acredita una limitación de todo CloudFormation. [UserPool CDK](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_cognito.UserPool.html), [factores CDK](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_cognito.AllowedFirstAuthFactors.html), [UserPool CloudFormation](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-cognito-userpool.html), [recursos SES](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/AWS_SES.html).

Access e ID tokens usan JWT RS256; el cliente se identifica mediante `client_id` en access token y `aud` en ID token. Validar firma, emisor, expiración, tipo de token y cliente son condiciones diferentes de autorizar acceso a un intento propio. Las URLs callback/logout se registran; los callbacks requieren HTTPS salvo excepciones documentadas de desarrollo. API Gateway puede validar JWT y entregar claims a Lambda. [Validación JWT](https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-using-tokens-verifying-a-jwt.html), [app clients](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-settings-client-apps.html), [authorizer](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-jwt-authorizer.html).

## Precios y cuotas publicados

La página Cognito consultada publica 10.000 MAU gratis para Lite/Essentials de usuarios directos/sociales, con condiciones de cuenta. Por encima del tramo gratuito, Essentials publica USD 0,015/MAU y Lite comienza en USD 0,0055/MAU; Plus publica USD 0,020/MAU sin ese free tier. La cantidad de usuarios concurrentes no determina los MAU facturados. [Precios Cognito](https://aws.amazon.com/cognito/pricing/).

SES publica modalidades con tarifas diferentes. À-la-carte incluye USD 0,10 por 1.000 emails salientes, más cargos aplicables; también existen planes con otros precios y posibles cargos fijos. La tarifa MAU de Cognito no sustituye la de SES propio. No se eligió un plan ni se estimó el costo mensual. [Precios SES](https://aws.amazon.com/ses/pricing/).

Defaults públicos Cognito por cuenta/región: `UserCreation` 50 RPS y `UserAuthentication` 120 RPS, ajustables. Las cuotas por usuario, challenge y envío son separadas. Los valores aplicados y las identidades existentes deben comprobarse en la cuenta, no derivarse del default público. [Cuotas](https://docs.aws.amazon.com/cognito/latest/developerguide/quotas.html).
