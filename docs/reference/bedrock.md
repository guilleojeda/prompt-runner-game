# Referencia técnica: Bedrock y modelos del catálogo

Fuentes oficiales consultadas el **16–17 de septiembre** para Sonnet 4.6 y el **1 de octubre de 2026** para los cuatro modelos añadidos al catálogo. Los hechos publicados describen APIs y perfiles posibles; no sustituyen las lecturas de cuenta ni una inferencia real. Los contratos están en [plataforma](../intent/plataforma.md), [agente](../intent/agente.md) y [consumo y puntuación](../intent/consumo-y-puntaje.md). Las menciones de Sonnet 5 sin decimal y sus tarifas/cuotas son contexto histórico de un modelo que no forma parte del catálogo vigente.

## APIs y regiones

| Modelo | Perfil usado por el catálogo | Acceso documentado desde `us-east-1` |
|---|---|---|
| Claude Sonnet 4.6 | `global.anthropic.claude-sonnet-4-6` | Converse, InvokeModel y streaming. La ficha consultada no documenta inferencia regional directa en Virginia. |
| Claude Sonnet 5.5 | `global.anthropic.claude-sonnet-5-5` | Converse en Runtime; perfil global. Adaptive thinking y effort configurable. |
| Claude Opus 5.5 | `global.anthropic.claude-opus-5-5` | Converse en Runtime; perfil global. |
| GPT-6.1 Sol | `us.openai.gpt-6.1-sol` | Converse en Runtime; el lanzamiento consultado ofrece perfil US, sin perfil global ni invocación regional directa. |
| GPT-6 Luna | `global.openai.gpt-6-luna` | Converse en Runtime; hay perfiles US/global documentados. El catálogo usa el perfil global. |

Fuentes: [Sonnet 4.6](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-sonnet-4-6.html), [Sonnet 5.5](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-sonnet-5-5.html), [Opus 5.5](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-opus-5-5.html), [GPT-6.1 Sol](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-6-1-sol.html) y [GPT-6 Luna](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-6-luna.html).

La región origen no garantiza dónde se procesa la inferencia. Los perfiles globales pueden enrutar a otras regiones y su identidad se conserva en el snapshot; el perfil US de GPT-6.1 Sol tiene sus propios destinos. Que un perfil exista o aparezca en el catálogo no demuestra que la cuenta tenga acuerdo, autorización y cuota para usarlo. La referencia de [cuenta AWS](cuenta-aws.md) distingue las lecturas fechadas de esos requisitos.

### Clientes TypeScript y credenciales del rol

`BedrockModel` usa el cliente AWS Bedrock Runtime y admite `stream: false` para Converse. `clientConfig` permite configurar el cliente. La aplicación utiliza el rol de ejecución, sin API keys ni credenciales en el navegador. [BedrockModelConfig](https://strandsagents.com/docs/api/typescript/BedrockModelConfig/), [BedrockModelOptions](https://strandsagents.com/docs/api/typescript/BedrockModelOptions/), [proveedor Bedrock](https://strandsagents.com/docs/user-guide/concepts/model-providers/amazon-bedrock/).

### Diferencias entre fichas y ejemplos

La ficha 5 exige un perfil para on-demand en runtime, mientras la guía Messages conserva ejemplos con el ID base. Además, la guía general Messages y la ficha 4.6 discrepan sobre el endpoint nativo Messages para ese modelo. Un cuerpo JSON de formato Anthropic en `InvokeModel` no es lo mismo que usar `/anthropic/v1/messages`. Los ejemplos no acreditan aceptación real. [Guía Messages](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-messages-api.html).

## Una herramienta por respuesta

Las herramientas del cliente son ejecutadas por la aplicación, no por el modelo. Este devuelve bloques `tool_use` con nombre, argumentos e identificador. Obtener esa llamada no exige reenviar después el resultado si no se desea continuar la conversación. [Contrato Claude en Bedrock](https://docs.aws.amazon.com/bedrock/latest/userguide/model-parameters-anthropic-claude-messages-request-response.html).

| Control | Garantía publicada y límite |
|---|---|
| Anthropic `tool_choice=auto` | Puede producir texto o herramientas. |
| Anthropic `any` | Fuerza alguna herramienta; por sí solo puede emitir varias. |
| Anthropic `disable_parallel_tool_use=true` | Con `auto`, como máximo una; con `any`/`tool`, exactamente una donde se admite uso forzado. |
| Converse `toolChoice.any` | Al menos una herramienta, no exactamente una. |
| Converse `toolChoice.tool` | Fuerza una específica; la referencia general no aclara de forma consistente su soporte específico en 5/4.6. |

Fuentes: [parallel tool use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/parallel-tool-use), [ToolChoice AWS](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ToolChoice.html).

Converse permite campos adicionales del modelo, pero esa capacidad genérica no demuestra el mapeo exacto de `disable_parallel_tool_use`. La aplicación sigue necesitando validar la respuesta antes de ejecutar una acción. [Converse](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Converse.html).

Sonnet 4.6 conserva el perfil anterior sin override de thinking. El catálogo fija adaptive thinking y effort `low` para Sonnet 5.5 y Opus 5.5; GPT-6.1 Sol y GPT-6 Luna omiten overrides de reasoning no acreditados para Converse. La forma efectiva de esos campos y los bytes aceptados se comprueban con el SDK durante la entrega; una ficha de otro endpoint no demuestra su mapeo a Converse. Sonnet 5 (sin decimal) conserva aquí sólo sus hechos históricos, fuera del catálogo actual. [Adaptive AWS](https://docs.aws.amazon.com/bedrock/latest/userguide/claude-messages-adaptive-thinking.html), [troubleshooting Anthropic](https://platform.claude.com/docs/en/build-with-claude/thinking-troubleshooting), [extended AWS](https://docs.aws.amazon.com/bedrock/latest/userguide/claude-messages-extended-thinking.html).

## Descripciones, esquemas e historial

En Converse, `description` es opcional pero tiene longitud mínima 1 si se envía. Omitirla y enviarla vacía son casos diferentes. `name` e `inputSchema` son obligatorios y el schema superior debe ser un objeto. No se encontró un mínimo publicado de propiedades. **Inferencia limitada:** un objeto sin parámetros puede representarse mediante un schema de objeto sin propiedades; no quedó probada cada representación concreta. [ToolSpecification](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ToolSpecification.html), [ToolInputSchema](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ToolInputSchema.html).

Claude InvokeModel también documenta descripción opcional. Strict tools añade garantías de schema en las modalidades compatibles, con un subconjunto JSON Schema acotado; no reemplaza la validación de la aplicación. [Request/response](https://docs.aws.amazon.com/bedrock/latest/userguide/model-parameters-anthropic-claude-messages-request-response.html), [structured outputs](https://docs.aws.amazon.com/bedrock/latest/userguide/structured-output.html).

Messages es stateless y permite solicitudes individuales con system prompt y un mensaje actual, sin reenviar historia. Eso no implica que un array de mensajes vacío sea válido. Las definiciones de herramientas agregan contenido técnico al contexto y consumen tokens. [Messages](https://platform.claude.com/docs/en/api/messages/create), [definición de herramientas](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools).

## Semántica del consumo

Converse publica `inputTokens`, `outputTokens`, `totalTokens` y campos de caché. El formato Anthropic usa `input_tokens`, `output_tokens`, `cache_read_input_tokens` y `cache_creation_input_tokens`, con posibles desgloses por TTL. Las guías de caché consultadas describen el input ordinario separado de lectura y escritura:

```text
entrada contabilizada = input ordinario + lectura de caché + escritura de caché
tokens de la invocación = entrada contabilizada + output reportado
```

El output ya incluye reasoning generado; un desglose de thinking es un subconjunto y no se vuelve a sumar. El tipo estándar `TokenUsage` de Converse no tiene campo específico de reasoning. La presencia de un desglose Anthropic en todas las combinaciones Bedrock/modelo no quedó garantizada. [Caché AWS](https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html), [caché Anthropic](https://platform.claude.com/docs/en/build-with-claude/prompt-caching), [TokenUsage](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_TokenUsage.html), [reasoning y costo](https://platform.claude.com/docs/en/build-with-claude/thinking-steering-and-cost).

La descripción de `totalTokens` no resuelve por sí sola cómo incluye los componentes de caché. Conservar uso original y normalizar según la API evita depender de esa ambigüedad. En streaming, los contadores finales pueden llegar al final; una interrupción previa puede dejar uso incompleto. Ausencia de contadores no significa costo cero. [Metadata ConverseStream](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ConverseStreamMetadataEvent.html), [streaming](https://platform.claude.com/docs/en/build-with-claude/streaming).

## Tarifas publicadas

La tabla siguiente conserva una consulta de tarifas Standard on-demand, **USD por millón de tokens**, origen Virginia, publicada el 11 de septiembre de 2026. Sonnet 5 es histórico y no pertenece al catálogo actual; estas tarifas no cubren Sonnet 5.5, Opus 5.5 ni GPT-6.1 Sol/GPT-6 Luna y no se usan como costo de la aplicación.

| Modelo/modalidad | Input | Output, incluido thinking | Write 5m | Write 1h | Read |
|---|---:|---:|---:|---:|---:|
| Sonnet 5 global | 2,00 | 10,00 | 2,50 | 4,00 | 0,20 |
| Sonnet 5 geo/regional | 2,20 | 11,00 | 2,75 | 4,40 | 0,22 |
| Sonnet 4.6 global | 3,00 | 15,00 | 3,75 | 6,00 | 0,30 |
| Sonnet 4.6 geo/regional | 3,30 | 16,50 | 4,125 | 6,60 | 0,33 |

La tarifa regional de la tabla no demuestra que toda combinación modelo/endpoint admita inferencia regional. La fuente numérica es el [mapping público de AWS](https://b0.p.awsstatic.com/pricing/2.0/meteredUnitMaps/bedrockfoundationmodels/USD/current/bedrockfoundationmodels.json), publicación **2026-09-11T12:44:10Z**, enlazado mediante las claves `priceOf` de [Bedrock Pricing](https://aws.amazon.com/bedrock/pricing/). Las claves `current` pueden cambiar: fecha y modalidad son parte de esta referencia, y las tarifas deben verificarse al implementar.

## Cuotas y habilitación

Los defaults públicos de cuotas y multiplicadores citados abajo corresponden a Sonnet 4.6 y al Sonnet 5 histórico, no a las cuatro incorporaciones actuales. Las cuotas aplicadas pueden diferir de los defaults publicados y deben leerse por perfil y modalidad antes de afirmar acceso operativo. [General Reference](https://docs.aws.amazon.com/general/latest/gr/bedrock.html).

La contabilidad de cuota tampoco equivale a los tokens del puntaje: runtime publica multiplicadores de output de 10 para Sonnet 5 y 5 para 4.6, excluye cache read del burndown y reserva capacidad considerando el límite de salida. [Burndown](https://docs.aws.amazon.com/bedrock/latest/userguide/quotas-token-burndown.html), [cuotas runtime](https://docs.aws.amazon.com/bedrock/latest/userguide/quotas-runtime.html).

La habilitación puede depender de permisos de inferencia, condiciones de Marketplace y formulario de primer uso de Anthropic. Los perfiles requieren permisos para sus destinos. Las cuotas de la cuenta se resuelven en Bedrock; una lectura de disponibilidad no equivale a una inferencia exitosa. [Acceso](https://docs.aws.amazon.com/bedrock/latest/userguide/model-access.html), [perfiles](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles-prereq.html).
