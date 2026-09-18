# Estado observado de la cuenta AWS

Consultas de lectura del **16 de septiembre de 2026**, entre **17:48:54 y 17:59:35 UTC**. Cuenta confirmada por STS: **387483252302**. Región consultada: **us-east-1**.

Este documento registra una observación fechada. No acredita un despliegue, una inferencia exitosa, la capacidad del juego o la configuración futura de CI. No se crearon recursos, enviaron emails, ejecutaron modelos ni solicitaron aumentos. Las credenciales temporales se usaron fuera del repositorio y se eliminaron localmente al terminar las consultas.

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

Estas cuotas no equivalen a una medición de 100 usuarios simultáneos: la concurrencia de Lambda depende de cuántas solicitudes estén ejecutándose y de su duración. No se hicieron pruebas de carga ni se modificaron los límites.

## Correo SES

`SESv2.GetAccount` devolvió:

- `SendingEnabled=true`.
- `ProductionAccessEnabled=false`.
- `Max24HourSend=200`, `MaxSendRate=1`, `SentLast24Hours=0`.

`ListEmailIdentities` devolvió cero identidades y cero dominios verificados. Por tanto, no se acreditó un emisor propio listo para registro abierto mediante SES en esta región. Esto no impide por sí mismo la modalidad de email predeterminado administrado por Cognito, que tiene otro contrato y otro límite, descritos en [identidad](identidad.md).

## Bootstrap CDK

- Lectura SSM `/cdk-bootstrap/hnb659fds/version`: `ParameterNotFound`.
- Lectura CloudFormation del stack `CDKToolkit`: `ValidationError`, stack inexistente.

No se encontró el bootstrap con el nombre y qualifier predeterminados. No se buscaron variantes personalizadas, por lo que no se afirma inexistencia de cualquier bootstrap posible. No se ejecutó `cdk bootstrap` ni se crearon roles o buckets.

## Método y alcance de la evidencia

Se consultaron STS `GetCallerIdentity`; Bedrock `Get/ListFoundationModels`, `Get/ListInferenceProfiles` y `GetFoundationModelAvailability`; Service Quotas `ListServices`, `ListServiceQuotas`, `GetServiceQuota` e historial; SESv2 `GetAccount`/`ListEmailIdentities`; SSM `GetParameter`; CloudFormation `DescribeStacks`.

Las lecturas exitosas acreditan permiso para esas operaciones, no todos los permisos de implementación. La herramienta informó `aws-cli/1.32.31` y `botocore/1.37.33`; para la API ausente del modelo local se utilizó su contrato HTTP oficial. No se imprimieron ni guardaron firmas, headers de autenticación o credenciales en esta documentación.
