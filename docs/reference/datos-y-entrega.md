# Referencia técnica: datos, API y entrega en AWS

Fuentes oficiales consultadas el **16 de septiembre de 2026**. Estas capacidades no seleccionan un esquema de datos, servicios de publicación ni un pipeline. Los compromisos del producto siguen en [plataforma](../intent/plataforma.md).

## DynamoDB: accesos y persistencia

Una clave compuesta permite agrupar registros por partition key y ordenarlos por sort key. `Query` requiere la partition key, ordena por sort key y permite invertir el orden. Cada página procesa hasta 1 MiB antes de filtros; los filtros no reducen la capacidad consumida. Cada ítem admite hasta 400 KiB. Con LSI, la colección de una partition key está limitada a 10 GiB. [Query](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_Query.html), [límites](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Constraints.html).

El servicio documenta patrones para versiones, pero no las hace inmutables: un `PutItem` con la misma clave reemplaza el registro. Una escritura exitosa queda persistida; las lecturas son eventualmente consistentes por defecto. Las tablas y LSI permiten consistencia fuerte; GSI y Streams son eventualmente consistentes. [Versiones](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/bp-sort-keys.html), [consistencia](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/HowItWorks.ReadConsistency.html).

Las escrituras individuales son atómicas. Las condiciones se evalúan contra el estado actualizado y pueden rechazar una escritura concurrente. Un incremento ordinario no es idempotente por sí mismo. `TransactWriteItems` admite hasta 100 acciones sobre ítems distintos, 4 MiB agregados y una única cuenta/región. Su `ClientRequestToken` tiene una ventana de idempotencia de diez minutos; no asegura deduplicación indefinida. [Operaciones](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/WorkingWithItems.html), [transacciones](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis.html).

TTL no es un reloj de borrado exacto: el ítem puede seguir visible y facturado hasta que se elimine. No define el reinicio de una cuota diaria ni es necesario para conservar el historial. [TTL](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/TTL.html).

**Inferencia para los accesos descritos por el producto:** hay operaciones documentadas para agrupar historial y condicionar actualizaciones concurrentes. Esto respalda mantener DynamoDB como opción viable; no acredita todavía un esquema concreto ni que un intento completo quepa en un único ítem.

## Objetos privados en S3

S3 ofrece consistencia fuerte tras PUT/DELETE. Un PUT reemplaza la clave actual salvo que se habilite versionado, en cuyo caso las versiones retenidas generan almacenamiento adicional. Los buckets nuevos bloquean acceso público por defecto y la autorización a objetos depende de las políticas aplicables. [Objetos](https://docs.aws.amazon.com/AmazonS3/latest/userguide/UsingObjects.html), [acceso público](https://docs.aws.amazon.com/AmazonS3/latest/userguide/access-control-block-public-access.html).

Los objetos superan ampliamente el límite de un ítem DynamoDB: la documentación actual permite un PUT de hasta 5 GB y objetos multipart de hasta 50 TB. Una URL presignada otorga acceso temporal con los permisos del firmante; su vigencia también queda limitada por la expiración de las credenciales temporales. No implementa por sí sola la autorización de un usuario del producto. [Carga](https://docs.aws.amazon.com/AmazonS3/latest/userguide/upload-objects.html), [URLs presignadas](https://docs.aws.amazon.com/AmazonS3/latest/userguide/ShareObjectPreSignedURL.html).

La consulta no seleccionó S3 como almacenamiento de registros; describe sus capacidades para poder comparar el almacenamiento completo cuando se diseñe.

## Solicitudes y trabajos en Lambda

| Interfaz | Límite o comportamiento documentado |
|---|---|
| Lambda estándar | Hasta 900 segundos por invocación. |
| API Gateway HTTP API | Integración hasta 30 segundos, no ampliable; payload hasta 10 MB. |
| Integración Lambda proxy de HTTP API | Invocación síncrona; espera respuesta de Lambda. |
| Lambda `InvocationType=Event` | Aceptación 202 y cola asíncrona; no devuelve el resultado del trabajo. |

Fuentes: [timeout Lambda](https://docs.aws.amazon.com/lambda/latest/dg/configuration-timeout.html), [HTTP API](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-quotas.html), [integración](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-develop-integrations-lambda.html), [Invoke](https://docs.aws.amazon.com/lambda/latest/api/API_Invoke.html).

Lambda asíncrona documenta dos reintentos por defecto ante error de función, tratamiento de throttling/errores del servicio hasta seis horas, posibilidad de duplicados y descarte por expiración. No garantiza exactamente una ejecución. Un 202 no demuestra éxito del agente invocado después. Los mecanismos de trabajo y sesión de AgentCore están en su [referencia](agentcore.md). [Reintentos](https://docs.aws.amazon.com/lambda/latest/dg/invocation-async-error-handling.html).

El authorizer JWT de HTTP API verifica firma RSA, emisor, audiencia o cliente, fechas y scopes configurados. Entrega claims a Lambda; no sustituye el control de pertenencia de cada configuración o intento. [JWT authorizer](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-jwt-authorizer.html).

## CDK y publicación de React

CDK v2 dispone de constructs TypeScript para DynamoDB, S3, Lambda, HTTP API y CloudFront. El soporte de AgentCore se documenta [por separado](agentcore.md). Las referencias actuales de prerrequisitos piden Node.js 22 o posterior. Las versiones concretas del proyecto todavía no fueron seleccionadas ni instaladas. [Prerrequisitos](https://docs.aws.amazon.com/cdk/v2/guide/prerequisites.html), [TypeScript](https://docs.aws.amazon.com/cdk/v2/guide/work-with-cdk-typescript.html).

Existen capacidades declarativas distintas de publicación estática:

- S3/CloudFront con `BucketDeployment`: publica un build existente mediante un custom resource y puede invalidar CloudFront. OAC sirve para un bucket S3 regular, no para su endpoint de website.
- Amplify mediante L1 CloudFormation/CDK: admite aplicaciones React y conexión a repositorios; esa conexión requiere token en el contrato de creación. También publica desde S3 o cargas manuales, con sus límites. El paquete L2 Amplify es experimental, separado de la biblioteca estable.

Fuentes: [BucketDeployment](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_s3_deployment-readme.html), [orígenes CloudFront](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_cloudfront_origins-readme.html), [Amplify CDK](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_amplify-readme.html), [Amplify App](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-amplify-app.html), [publicación desde S3](https://docs.aws.amazon.com/amplify/latest/userguide/deploy-website-from-s3.html).

CLI y `aws-cdk-lib` tienen numeraciones desacopladas desde CLI 2.1000.0. Comparar sus números no establece compatibilidad: el CLI debe soportar el Cloud Assembly Schema generado por la biblioteca. La tabla oficial relaciona las versiones compatibles. [Versionado](https://docs.aws.amazon.com/cdk/v2/guide/versioning.html), [COMPATIBILITY.md](https://github.com/aws/aws-cdk-cli/blob/main/COMPATIBILITY.md).

## GitHub Actions y bootstrap

GitHub puede emitir tokens OIDC para obtener credenciales AWS temporales mediante STS. `id-token: write` permite solicitar el JWT; no concede permisos AWS. La confianza debe corresponder al emisor, audiencia y subject reales del repositorio o environment. La documentación de julio de 2026 introduce claims con identificadores inmutables en repositorios nuevos u opt-in; no asumir un único formato histórico de `sub`. [OIDC con AWS](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-aws), [claims](https://docs.github.com/en/actions/reference/security/oidc).

El bootstrap moderno de CDK es por cuenta/región y normalmente crea `CDKToolkit`, assets S3/ECR, roles y un parámetro SSM de versión. Los permisos de la identidad que ejecuta bootstrap son distintos de los roles usados en los despliegues posteriores. La política amplia documentada para bootstrap no implica otorgar esos mismos permisos a todos los jobs. La función de cada rol y sus permisos depende del entorno bootstrap y de CloudFormation. [Bootstrap](https://docs.aws.amazon.com/cdk/v2/guide/bootstrapping-env.html), [roles de despliegue](https://docs.aws.amazon.com/cdk/v2/guide/deploy.html).

Las decisiones de ambiente, publicación y circuito de CI/CD están en [acceso y entrega](../architecture/acceso-y-entrega.md). La existencia de OIDC y constructs declarativos no prueba que el repositorio y la cuenta ya estén configurados para utilizarlos; la trust policy y el pipeline se concretarán y comprobarán durante la implementación.

## Referencias de costo

Tarifas públicas consultadas para `us-east-1`, sin medir el uso de la aplicación ni descuentos de cuenta:

| Servicio | Unidad y tarifa de referencia |
|---|---|
| DynamoDB Standard on-demand | USD 0,625/millón WRU; 0,125/millón RRU; 0,25/GB-mes. Lecturas y escrituras se redondean por tamaño; transacciones consumen el doble. |
| S3 Standard | USD 0,023/GB-mes en el primer tramo; 0,0004/1.000 GET y 0,005/1.000 PUT. Transferencia y otras opciones se facturan según modalidad. |
| CloudFormation | Sin cargo adicional por recursos nativos `AWS::*`; los recursos creados tienen sus propios cargos. |
| GitHub Actions | Cuotas gratuitas y facturación dependen del plan y repositorio; el precio publicado de Linux 2-core fuera de la cuota es USD 0,006/min. |

Fuentes: [DynamoDB](https://aws.amazon.com/dynamodb/pricing/), [S3](https://aws.amazon.com/s3/pricing/), [CloudFormation](https://aws.amazon.com/cloudformation/pricing/), [GitHub Actions](https://docs.github.com/en/billing/concepts/product-billing/github-actions).

La cuenta real, el plan GitHub, los tamaños de registros y la cantidad de solicitudes siguen siendo necesarios para estimar gasto total. Las cifras anteriores no son un presupuesto aprobado ni una garantía de costo.
