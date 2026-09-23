# Referencia técnica: Bedrock y Claude Sonnet

Fuentes oficiales consultadas el **16–17 de septiembre de 2026**. Esta referencia documenta los contratos de Sonnet 4.6 y Sonnet 5 con `BedrockModel` de Strands, perfil global y Converse sin streaming; las fuentes del servicio no sustituyen la verificación de la cuenta. Los contratos están en [plataforma](../intent/plataforma.md), [agente](../intent/agente.md) y [consumo y puntuación](../intent/consumo-y-puntaje.md).

## APIs y regiones

| Modelo y servicio | Acceso documentado desde `us-east-1` |
|---|---|
| Sonnet 5, `bedrock-runtime` | InvokeModel, Converse y streaming; perfiles `us.anthropic.claude-sonnet-5` o `global.anthropic.claude-sonnet-5`. También figura el endpoint nativo Messages. |
| Sonnet 4.6, `bedrock-runtime` | InvokeModel, Converse y streaming; perfiles `us.anthropic.claude-sonnet-4-6` o `global.anthropic.claude-sonnet-4-6`. Sin inferencia regional directa en Virginia según la ficha. |

Fuentes: [Sonnet 5](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-sonnet-5.html), [Sonnet 4.6](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-sonnet-4-6.html).

La región origen no garantiza dónde se procesa la inferencia. El perfil global puede enrutar a otras regiones; esa modalidad está permitida y se conserva en el snapshot. El modelo operativo es Sonnet 4.6. Sonnet 5 se conserva como perfil conocido para registros históricos; habilitar su uso nuevo requiere completar la verificación de acceso e inferencia.

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

Sonnet 5 activa adaptive thinking por defecto y admite desactivarlo; no admite `enabled` con `budget_tokens`. Sonnet 4.6 omite thinking por defecto y admite adaptive y manual, este último deprecado. La documentación actual de Anthropic permite uso forzado con adaptive y lo rechaza con manual extended thinking. Algunas advertencias AWS dicen “thinking” de manera general; no demuestran que todos los modos tengan la misma restricción. [Adaptive AWS](https://docs.aws.amazon.com/bedrock/latest/userguide/claude-messages-adaptive-thinking.html), [troubleshooting Anthropic](https://platform.claude.com/docs/en/build-with-claude/thinking-troubleshooting), [extended AWS](https://docs.aws.amazon.com/bedrock/latest/userguide/claude-messages-extended-thinking.html).

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

AWS Standard on-demand, **USD por millón de tokens**, origen Virginia. No es una estimación del gasto de la aplicación.

| Modelo/modalidad | Input | Output, incluido thinking | Write 5m | Write 1h | Read |
|---|---:|---:|---:|---:|---:|
| Sonnet 5 global | 2,00 | 10,00 | 2,50 | 4,00 | 0,20 |
| Sonnet 5 geo/regional | 2,20 | 11,00 | 2,75 | 4,40 | 0,22 |
| Sonnet 4.6 global | 3,00 | 15,00 | 3,75 | 6,00 | 0,30 |
| Sonnet 4.6 geo/regional | 3,30 | 16,50 | 4,125 | 6,60 | 0,33 |

La tarifa regional de la tabla no demuestra que toda combinación modelo/endpoint admita inferencia regional. La fuente numérica es el [mapping público de AWS](https://b0.p.awsstatic.com/pricing/2.0/meteredUnitMaps/bedrockfoundationmodels/USD/current/bedrockfoundationmodels.json), publicación **2026-09-11T12:44:10Z**, enlazado mediante las claves `priceOf` de [Bedrock Pricing](https://aws.amazon.com/bedrock/pricing/). Las claves `current` pueden cambiar: fecha y modalidad son parte de esta referencia, y las tarifas deben verificarse al implementar.

## Cuotas y habilitación

Los defaults públicos runtime para Sonnet 4.6 geo/global incluyen 10.000 RPM y 6 millones TPM; para 5 se publicó 6 millones TPM geo/global, sin encontrar una fila RPM específica en la consulta. Las cuotas aplicadas a la cuenta pueden ser diferentes. [General Reference](https://docs.aws.amazon.com/general/latest/gr/bedrock.html).

La contabilidad de cuota tampoco equivale a los tokens del puntaje: runtime publica multiplicadores de output de 10 para Sonnet 5 y 5 para 4.6, excluye cache read del burndown y reserva capacidad considerando el límite de salida. [Burndown](https://docs.aws.amazon.com/bedrock/latest/userguide/quotas-token-burndown.html), [cuotas runtime](https://docs.aws.amazon.com/bedrock/latest/userguide/quotas-runtime.html).

La habilitación puede depender de permisos de inferencia, condiciones de Marketplace y formulario de primer uso de Anthropic. Los perfiles requieren permisos para sus destinos. Las cuotas de la cuenta se resuelven en Bedrock; una lectura de disponibilidad no equivale a una inferencia exitosa. [Acceso](https://docs.aws.amazon.com/bedrock/latest/userguide/model-access.html), [perfiles](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles-prereq.html).
