# Estado observado de la cuenta AWS

Cuenta confirmada por STS: **387483252302**. Región: **us-east-1**. El correo se comprobó el **30 de septiembre de 2026**; las demás secciones conservan las consultas del **16 de septiembre**, entre **17:48:54 y 17:59:35 UTC**.

Este documento registra observaciones fechadas. No acredita por sí solo un despliegue, una inferencia exitosa o la capacidad del juego. Las consultas originales fueron de lectura; la preparación operativa de correo se describe en su sección. Las credenciales temporales se usan fuera del repositorio y se eliminan localmente al terminar.

## Bedrock: catálogo, perfiles y disponibilidad

`GetFoundationModel`/`ListFoundationModels` devolvieron `ACTIVE` para `anthropic.claude-sonnet-5` y `anthropic.claude-sonnet-4-6`. Los perfiles `us.*` y `global.*` de ambos modelos aparecieron `SYSTEM_DEFINED` y `ACTIVE`.

Los perfiles US consultados devolvieron destinos `us-east-1`, `us-east-2` y `us-west-2` para ambos modelos. Es el valor observado en esta consulta; no reemplaza la descripción más amplia de geografías posibles de la [referencia Bedrock](bedrock.md).

`GetFoundationModelAvailability` devolvió HTTP 200:

| Campo | Sonnet 5, 17:59:34 UTC | Sonnet 4.6, 17:59:35 UTC |
|---|---|---|
| `agreementAvailability.status` | `NOT_AVAILABLE` | `NOT_AVAILABLE` |
| `authorizationStatus` | `AUTHORIZED` | `AUTHORIZED` |
| `entitlementAvailability` | `AVAILABLE` | `AVAILABLE` |
| `regionAvailability` | `AVAILABLE` | `AVAILABLE` |

La disponibilidad se consultó mediante `GET /foundation-model-availability/{modelId}` con SigV4. [API](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_GetFoundationModelAvailability.html).

La guía AWS identifica `agreementAvailability=NOT_AVAILABLE` como ausencia del acceso/acuerdo correspondiente. Catálogo activo, autorización y disponibilidad regional no bastan para demostrar uso operativo. La habilitación y las cuotas se resuelven para la integración Bedrock elegida por el producto. [Acceso a modelos](https://docs.aws.amazon.com/bedrock/latest/userguide/model-access.html).

## Cuotas aplicadas de Bedrock

Los valores siguientes fueron devueltos por `GetServiceQuota` con `QuotaAppliedAtLevel=ACCOUNT`. En estas cuotas el campo `Unit` fue `None`; las unidades de la tabla se toman del nombre publicado de cada cuota. La respuesta no incluye fecha de modificación: se conserva la fecha de observación.

| Modelo/modalidad | Cuota | Código | Valor aplicado |
|---|---|---|---:|
| Sonnet 5, runtime global | Tokens/min | `L-DD84E5CA` | 0 |
| Sonnet 5, runtime cross-region | Tokens/min | `L-D4FBCF4E` | 0 |
| Sonnet 4.6, runtime global | Requests/min | `L-F6E116D7` | 0 |
| Sonnet 4.6, runtime cross-region | Requests/min | `L-00FF3314` | 0 |
| Sonnet 4.6, runtime cross-region | Tokens/min | `L-15B8E632` | 0 |
| Sonnet 4.6, runtime global | Tokens/min | `L-7BEE40FB` | 0 |

No se encontraron otras cuotas on-demand con esos nombres de modelo en las respuestas consultadas. La ausencia de una fila no acredita ausencia de límites internos.

**Interpretación acotada:** el cero es el límite aplicado que devuelve esa dimensión de Service Quotas. No sustituye los campos de autorización/acuerdo ni prueba el resultado de una inferencia. [GetServiceQuota](https://docs.aws.amazon.com/servicequotas/2019-06-24/apireference/API_GetServiceQuota.html).

## AgentCore, Lambda y Cognito

| Servicio | Cuota aplicada | Código | Valor |
|---|---|---|---:|
| AgentCore | Nuevas sesiones Runtime por segundo | `L-8EE2AEA2` | 25 |
| AgentCore | Operaciones data plane por segundo | `L-46ED137C` | 1.000 |
| AgentCore | Sesiones activas por cuenta | `L-3E5722B2` | 5.000 |
| Lambda | Ejecuciones concurrentes | `L-B99A9384` | 10 |
| Cognito | UserCreation por segundo | `L-5987B8A0` | 50 |
| Cognito | UserAuthentication por segundo | `L-026ADBA3` | 120 |
| Cognito | ClientAuthentication por segundo | `L-74D3DD04` | 150 |
| Cognito | UserToken por segundo | `L-F21F8BB4` | 120 |

No aparecieron cuotas con nombre Harness ni Email de Cognito en las respuestas consultadas. No se encontró historial de solicitudes de aumento para los servicios consultados.

Estas cuotas describen ritmos de solicitudes y ejecuciones concurrentes, no un límite de cien cuentas totales. La concurrencia de Lambda depende de cuántas solicitudes estén ejecutándose y de su duración. En esta consulta del 16 de septiembre no se hicieron pruebas de carga ni se modificaron los límites.

## Correo SES

El 30 de septiembre de 2026, `SESv2.GetAccount` confirmó acceso de producción aprobado (`ReviewDetails.Status=GRANTED`):

- `SendingEnabled=true`.
- `ProductionAccessEnabled=true`.
- `Max24HourSend=50000`, `MaxSendRate=14`.
- Estado `HEALTHY` y supresión de destinos por `BOUNCE` y `COMPLAINT`.

La identidad `dondeaprendoaws.com` está verificada para enviar; Easy DKIM usa RSA de 2048 bits, firma habilitada y estado `SUCCESS`. Sus tres CNAME se publicaron en la zona Route 53 del dominio, administrada en la cuenta `719535286359`, sin cambiar NS ni los MX de Google. La identidad pertenece a la cuenta del juego y está en la misma región que Cognito.

El remitente es `hello@dondeaprendoaws.com`, un alias de Google Workspace recibido por el dueño en `gojeda@dreamoncloud.com`. Se comprobó la recepción de un mensaje SES con firma DKIM del dominio. El forwarding de rebotes y quejas de SES está habilitado; el operador revisa esa casilla y resuelve los destinos afectados antes de insistir. No se añade SNS ni una Lambda de correo. El rol nativo `AWSServiceRoleForAmazonCognitoIdpEmailService` está preparado. Identidad, DNS, rol y solicitud de producción son operaciones únicas fuera de CDK; el envío y la plantilla del User Pool se administran mediante el circuito declarativo descrito en [acceso y entrega](../architecture/acceso-y-entrega.md).

Las cuotas son las efectivas en esa lectura y no garantizan recepción ni capacidad permanente. El consumo cambia con los envíos y se consulta con `sesv2 get-account`; no se debe agotar la cuota para verificar errores de interfaz. El remitente, el texto español y los códigos de alta, reenvío y recuperación requieren verificación en el flujo publicado, según [identidad](identidad.md).

## Bootstrap CDK

- Lectura SSM `/cdk-bootstrap/hnb659fds/version`: `ParameterNotFound`.
- Lectura CloudFormation del stack `CDKToolkit`: `ValidationError`, stack inexistente.

No se encontró el bootstrap con el nombre y qualifier predeterminados. No se buscaron variantes personalizadas, por lo que no se afirma inexistencia de cualquier bootstrap posible. No se ejecutó `cdk bootstrap` ni se crearon roles o buckets.

## Método y alcance de la evidencia

Se consultaron STS `GetCallerIdentity`; Bedrock `Get/ListFoundationModels`, `Get/ListInferenceProfiles` y `GetFoundationModelAvailability`; Service Quotas `ListServices`, `ListServiceQuotas`, `GetServiceQuota` e historial; SESv2 `GetAccount`/`ListEmailIdentities`; SSM `GetParameter`; CloudFormation `DescribeStacks`.

Las lecturas exitosas acreditan permiso para esas operaciones, no todos los permisos de implementación. La herramienta informó `aws-cli/1.32.31` y `botocore/1.37.33`; para la API ausente del modelo local se utilizó su contrato HTTP oficial. No se imprimieron ni guardaron firmas, headers de autenticación o credenciales en esta documentación.
