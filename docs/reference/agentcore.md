# Referencia técnica: AgentCore

Fuentes oficiales consultadas el **16–17 de septiembre de 2026**. Esta referencia respalda la arquitectura acordada de Runtime con Strands TypeScript; las capacidades publicadas no prueban una integración ejecutada. Los contratos están en [agente](../intent/agente.md), [intentos](../intent/intentos.md) y [plataforma](../intent/plataforma.md).

## Responsabilidad sobre la ejecución

| Servicio | Responsabilidad documentada |
|---|---|
| Runtime | Alojamiento, aislamiento, sesiones, autenticación y escalado. El código alojado controla su loop y las solicitudes al modelo. El payload de invocación pertenece al contrato de ese código. |
| Harness | Loop administrado basado en Strands, con configuración de modelo, instrucciones, herramientas, memoria y límites; se ejecuta dentro de Runtime. |

Fuentes: [comparación oficial](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness-vs-runtime.html), [InvokeAgentRuntime](https://docs.aws.amazon.com/bedrock-agentcore/latest/APIReference/API_InvokeAgentRuntime.html).

**Inferencia:** Runtime permite que el código determine las instrucciones, herramientas e historial enviados. El servicio no impone un contrato universal que los limite; la aplicación debe cumplir su propio contrato de observación y registro.

## Controles y límites de Harness

`InvokeHarness` permite cambiar por invocación mensajes, system prompt, modelo, herramientas, `allowedTools`, skills, actor y límites. `maxIterations` limita ciclos del loop; no garantiza por sí mismo una única llamada al modelo o a herramientas. [API](https://docs.aws.amazon.com/bedrock-agentcore/latest/APIReference/API_InvokeHarness.html).

Las herramientas `inline_function` admiten nombre, descripción y JSON Schema por invocación. Harness devuelve la elección y pausa para que el cliente ejecute la función. El turno parcial no se persiste: continuar requiere reenviar explícitamente `toolUse` y `toolResult`. El cliente puede terminar allí y construir otra invocación independiente. `allowedTools` permite restringir el catálogo y excluir los builtins `shell` y `file_operations`. El juego siempre exige al menos una herramienta; no necesita una allowlist vacía para exponer únicamente sus herramientas inline. [Herramientas](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness-tools.html).

**La memoria se puede desactivar completamente** mediante `HarnessMemoryConfiguration.disabled`: al crear, `memory: { disabled: {} }`. La guía oficial actual vincula la carga de historial entre invocaciones a tener memoria habilitada. Distingue también API —memoria administrada si se omite la configuración— y CLI —memoria deshabilitada por defecto—. `truncation=none` conserva historial sin truncar y no es el control de desactivación. [Contrato de memoria](https://docs.aws.amazon.com/bedrock-agentcore-control/latest/APIReference/API_HarnessMemoryConfiguration.html), [guía oficial actual](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness-memory.md).

El historial entre invocaciones es distinto de los mensajes que un loop de varios pasos produce durante una misma ejecución. Una invocación por decisión puede devolver una función inline sin continuar con su resultado.

`InvokeHarness.systemPrompt` reemplaza el prompt configurado por defecto para esa invocación; no se documenta concatenación entre esos dos textos. Mensajes, instrucciones y catálogo pueden fijarse por decisión. Esto permite plantear la configuración del juego sin atribuirle a Harness una estrategia obligatoria oculta. [API de invocación](https://docs.aws.amazon.com/bedrock-agentcore/latest/APIReference/API_InvokeHarness.html), [modelos e instrucciones](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness-models.html).

Las skills pueden agregar metadatos al system prompt e instrucciones cargadas mediante herramientas; el juego no requiere ese contenido adicional. Hay trazas de llamadas, herramientas y payloads en CloudWatch, con Transaction Search configurado. La integración debe comprobar que se pueden conservar los datos efectivos que exige el diagnóstico del juego. Esa verificación pendiente no demuestra que el contenido sea inevitable o que Harness sea incompatible. [Skills](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness-skills.html), [operación y observabilidad](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness-operations.html).

Estos controles explican por qué Harness es una alternativa viable. El fundamento para usar Runtime con Strands es la ubicación de la coordinación y las funciones del juego, descrita en [ejecución](../architecture/ejecucion.md).

## Strands dentro de Runtime

Runtime es alojamiento; Strands es un SDK que puede ejecutarse en ese alojamiento. Harness administra un loop basado en Strands. Son tres combinaciones distintas: Harness administrado, Runtime con Strands en la aplicación, y Runtime con llamadas directas al proveedor.

Strands tiene SDK TypeScript (`@strands-agents/sdk`). `AgentConfig` permite definir mensajes iniciales, herramientas y system prompt, además de configurar gestores de sesión y memoria. Por tanto, usar Strands no obliga a compartir la conversación entre decisiones: una instancia nueva por decisión es una alternativa a configurar la gestión del estado de una instancia reutilizada. Esa instancia es un objeto de aplicación, no exige crear un recurso AWS nuevo. [Quickstart TypeScript](https://strandsagents.com/docs/user-guide/quickstart/typescript/), [AgentConfig](https://strandsagents.com/docs/api/typescript/AgentConfig/).

Los hooks permiten observar llamadas al modelo y herramientas y modificar su ejecución; `BeforeModelCallEvent.cancel` puede impedir una llamada. Es una superficie concreta para detener la continuación automática del loop. No se verificó aún la combinación completa que seleccione, valide, registre y ejecute exactamente una acción por decisión. [Hooks](https://strandsagents.com/docs/user-guide/concepts/agents/hooks/), [BeforeModelCallEvent](https://strandsagents.com/docs/api/typescript/BeforeModelCallEvent/).

También existe la superficie de modelo `stream`/`streamAggregated`, que recibe mensajes y devuelve bloques, respuesta y metadata. Permite evaluar reutilizar el adaptador de modelos de Strands sin adoptar todo su loop de agente. [Model](https://strandsagents.com/docs/api/typescript/Model/).

La guía Strands documenta `BedrockModel` para la API Bedrock Runtime, que es la integración elegida por el producto. [Proveedor Bedrock](https://strandsagents.com/docs/user-guide/concepts/model-providers/amazon-bedrock/).

`BedrockModelConfig.stream` selecciona Converse o ConverseStream. `BedrockModelOptions.clientConfig` acepta configuración del cliente AWS Bedrock Runtime. Son superficies para elegir respuesta sin streaming e instrumentar el cliente; no se probó aquí una captura de bodies. La estimación de contexto (`countTokens`) es distinta del uso de inferencia reportado y no debe usarse como consumo real del juego. [BedrockModelConfig](https://strandsagents.com/docs/api/typescript/BedrockModelConfig/), [BedrockModelOptions](https://strandsagents.com/docs/api/typescript/BedrockModelOptions/).

## TypeScript y despliegue declarativo

| Superficie | Soporte observado en documentación |
|---|---|
| Contenedor Runtime | ARM64; HTTP en `0.0.0.0:8080`, `/invocations` y `/ping`. El contrato no exige Python. |
| Runtime CodeZip | `NODE_22` y runtimes Python. TypeScript debe compilarse a JavaScript. |
| SDK TypeScript de AgentCore | Referencia consultada de `bedrock-agentcore` v0.4.1: aplicación HTTP/SSE y tareas asíncronas. |
| Cliente AWS SDK v3 | Comandos de invocación de Runtime y Harness desde TypeScript. |
| Exportación de Harness | Actualmente Python/Strands; esto no restringe el lenguaje del cliente de sus APIs. |
| CloudFormation | Recursos Runtime, RuntimeEndpoint, Harness y HarnessEndpoint. |
| CDK | Referencia 2.268.0 con recursos L1 `CfnRuntime`/`CfnHarness` y L2 Runtime. No se encontró L2 Harness documentado. |

Fuentes: [contrato HTTP](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-http-protocol-contract.html), [Node.js CodeZip](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-get-started-code-deploy-node.html), [SDK TypeScript](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/agentcore-typescript-sdk-reference.html), [InvokeHarnessCommand](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/bedrock-agentcore/command/InvokeHarnessCommand/), [exportación](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness-export.html), [CloudFormation](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/AWS_BedrockAgentCore.html), [CDK](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_bedrockagentcore-readme.html).

Las referencias CDK consultadas no cubren todos los campos presentes en CloudFormation: por ejemplo, capacity provider/filesystem en algunas superficies Runtime y parámetros LiteLLM en Harness. Son diferencias de las versiones/documentación consultadas; no prueban que una versión posterior o todo uso de CDK carezca de soporte. [RuntimeProps](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_bedrockagentcore.RuntimeProps.html), [CfnRuntime](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_bedrockagentcore.CfnRuntime.html), [Harness CloudFormation](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-bedrockagentcore-harness.html).

## Continuidad, sesión y almacenamiento

Runtime documenta trabajo asíncrono **después de responder** al cliente. El proceso informa `HealthyBusy` para evitar terminación por inactividad mientras trabaja. El SDK TypeScript ofrece registro y finalización de tareas asíncronas. Sigue aplicando el máximo de vida del cómputo. [Trabajo prolongado](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-long-run.html).

Una sesión identificable no implica un proceso permanente: tras terminar el cómputo, reutilizar el identificador puede iniciar otro entorno sin su RAM ni disco ordinario. La configuración de microVM permite hasta ocho horas; el timeout de inactividad predeterminado es 15 minutos. [Sesiones](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-sessions.html), [ciclo de vida](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-lifecycle-settings.html).

No se encontró una garantía general de continuidad del loop por el solo hecho de que el navegador corte un stream, ni de recuperación automática de un trabajo tras muerte del proceso, ni de guardado automático de su resultado final. El modo de tareas asíncronas documentado es un contrato diferente. El almacenamiento de sesión Preview tiene expiración y límites; no acredita conservación indefinida de los registros del producto. [Filesystem](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-filesystem-configurations.html).

Las APIs de invocación de AgentCore no publican una modalidad equivalente a `InvocationType=Event` ni un token de idempotencia de la invocación. Los reintentos de una Lambda que las consume no convierten la ejecución remota en exactamente una vez. [InvokeAgentRuntime](https://docs.aws.amazon.com/bedrock-agentcore/latest/APIReference/API_InvokeAgentRuntime.html), [InvokeHarness](https://docs.aws.amazon.com/bedrock-agentcore/latest/APIReference/API_InvokeHarness.html), [reintentos de Lambda](https://docs.aws.amazon.com/lambda/latest/dg/invocation-async-error-handling.html).

## Cuotas y costos publicados

Defaults públicos para Runtime en `us-east-1`, también aplicables a Harness: 5.000 sesiones activas por cuenta, 25 nuevas sesiones/s y 1.000 operaciones/s de data plane, ajustables. Duraciones: solicitud síncrona 15 minutos, stream 60 minutos y trabajo asíncrono hasta ocho horas. La vida de una sesión no amplía por sí sola el límite de una conexión. Estos valores no sustituyen las cuotas aplicadas de una cuenta. [Cuotas](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/bedrock-agentcore-limits.html).

La página pública consultada publica Runtime microVM a USD 0,0895 por vCPU-h y USD 0,00945 por GB-h, con medición de CPU utilizada y memoria alcanzada, por segundo. Harness no añade un cargo propio. Inferencia, Memory, almacenamiento, red y observabilidad se cobran según el uso. No se verificó aquí un SKU regional mediante Pricing API ni se midió un intento de juego. [Precios](https://aws.amazon.com/bedrock/agentcore/pricing/).

## Verificación de la integración elegida

Las llamadas efectivas deben demostrar contexto nuevo por decisión, selección de una sola herramienta, captura completa de request/response y uso real. La tarea de background debe sostener el cálculo al cerrar el navegador. La disponibilidad de APIs y cuotas no sustituye esas comprobaciones.
