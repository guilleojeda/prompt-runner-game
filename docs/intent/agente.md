# Agente, herramientas y observación

Este documento es canónico para el contrato de decisión del agente, sus herramientas, la información que recibe y la captura de configuraciones. El editor, los snapshots y la ejecución independiente por decisión usan el nivel periódico vigente. La inspección detallada en la interfaz sigue pendiente; sus datos se conservan desde la ejecución. Se relaciona con [experiencia](experiencia.md), [intentos](intentos.md), [juego](juego.md), [consumo y puntaje](consumo-y-puntaje.md) y [plataforma](plataforma.md).

## Configuración disponible

El catálogo permite preparar Avanzar (`tool_1`), Retroceder (`tool_2`), Saltar (`tool_3`), Agacharse y avanzar (`tool_4`), Nadar (`tool_5`), Esperar (`tool_6`) y Agarrar objeto (`tool_7`). Sólo Avanzar comienza habilitado; Esperar y Agarrar objeto comienzan deshabilitadas. Las descripciones empiezan vacías y las instrucciones muestran la frase de orientación acordada. La ayuda sobre el efecto de una habilidad se presenta separada del campo editable y no completa el texto del usuario. Probar ejecuta estas acciones en el nivel `principal-recompensas-v3`.

Las referencias internas, IDs opacos y schemas pertenecen al catálogo versionado. Deshabilitar/reactivar no cambia el ID ni borra la descripción. El servidor rechaza referencias o versiones desconocidas e intentos de editar los contratos fijos. El borrador conserva textos literales y puede tener cero habilidades; Probar exige al menos una habilidad conforme a las reglas siguientes. [Guardado y concurrencia](../architecture/datos.md#borrador-disponible).

## Independencia estricta entre turnos

Cada decisión del intento es una invocación nueva e independiente. El mundo conserva estado interno —posición, turno, objetos restantes e inventario—, pero ese estado no se convierte en historial del modelo. En cada turno se construye una solicitud con únicamente:

1. un protocolo técnico mínimo para pedir una única llamada a herramienta;
2. las instrucciones generales de la configuración capturada por **Probar**;
3. todas las herramientas habilitadas en esa configuración;
4. una observación local nueva del estado presente.

La solicitud no incluye la conversación anterior, decisiones, llamadas, resultados, errores, intención, orientación o resumen de ningún turno previo. Esta regla rige dentro de un mismo intento y entre intentos. No pedir al modelo un plan completo ni un arreglo de acciones: cada respuesta decide una sola acción y la siguiente observación se construye después de resolverla.

Un proveedor puede reutilizar técnicamente un prefijo mediante caché. Eso no autoriza enviar historial ni mantener una conversación funcional. La condición verificable es el payload efectivo de cada decisión.

## Payload permitido

El payload debe construirse desde una lista explícita de campos permitidos:

- **Protocolo:** elegir una única herramienta habilitada, respetar su esquema y decidir para la observación presente. No contiene la solución del nivel, equivalencias entre nombres e identificadores, reglas de obstáculos, ciclos ni una estrategia ganadora.
- **Instrucciones generales:** texto escrito y aplicado por el humano. Se conserva exactamente, incluida una descripción ambigua o equivocada.
- **Herramientas habilitadas:** todas las capacidades seleccionadas para el intento, aunque ninguna sea compatible con el obstáculo actual. Cada una lleva su identificador opaco, esquema fijo y descripción editable.
- **Observación local:** objetos disponibles en el apoyo actual y estado de la salida si corresponde (la salida vigente siempre está habilitada); estado presente del tramo inmediato a la izquierda o un límite; y estado presente del tramo inmediato a la derecha o un límite.

Los nombres de campos son una decisión de implementación. Los estados pueden usar términos comprensibles como `suelo`, `pozo`, `rama baja`, `barrera baja` y `barrera alta`. La observación no debe decir qué herramienta resuelve el estado ni entregar una lista de movimientos válidos.

## Información prohibida

El modelo no recibe:

- mapa completo, tramos lejanos, cantidad total de tramos o identificadores de casillas;
- coordenadas globales o índice de apoyo;
- turno actual, cantidad de decisiones previas o turnos restantes;
- fórmula del ciclo, período, desfase ni fase futura de un obstáculo;
- inventario completo, objetos ya recogidos, puntaje o consumo acumulado;
- resultado de la acción anterior, estado anterior, errores previos o resultados de intentos anteriores;
- descripciones corregidas, completadas o enriquecidas automáticamente;
- equivalencias entre un identificador opaco y su acción semántica, por metadatos, títulos, nombres de función o texto técnico añadido por el sistema.

El backend puede conocer toda esa información para resolver y registrar el intento. No debe enviar un objeto de mundo completo confiando en que el prompt indique al modelo qué ignorar.

Las instrucciones generales sí pueden expresar un objetivo, como llegar a la salida. Lo prohibido es agregar al payload un destino, una intención u orientación como dato oculto del mundo o como recuerdo de turnos previos.

## Identidad de las herramientas

Cada capacidad separa su identidad semántica interna de sus representaciones humanas y del contrato enviado al modelo:

- una referencia semántica interna, que el motor usa para aplicar el efecto real;
- un nombre humano para la interfaz, como `Saltar`;
- un identificador opaco enviado al modelo, como `tool_3`;
- una descripción escrita por el usuario;
- un esquema de parámetros fijado por la implementación.

El default actual mantiene estable el identificador opaco por habilidad durante una sesión. Habilitar o deshabilitar otras habilidades no debe cambiar esa relación mientras se use ese default. Los números concretos no son un compromiso; la opacidad sí forma parte del comportamiento esperado.

Los nombres humanos y el efecto real pueden mostrarse en la interfaz o en una vista técnica para explicar el juego. Esa ayuda de UI no se inyecta automáticamente en la solicitud. El modelo tampoco recibe la identidad semántica mediante nombres de función, títulos auxiliares, metadatos ni una descripción automática. Un esquema puede indicar la forma de un argumento —por ejemplo, una dirección `izquierda` o `derecha`—, pero no debe explicar qué habilidad conviene ante cada obstáculo.

Todas las herramientas habilitadas viajan en cada decisión. El adaptador no filtra el catálogo según lo que funcionaría en el obstáculo presente. Las capacidades distractoras siguen teniendo efectos deterministas definidos por el motor, incluido un no-op cuando corresponda.

## Descripciones e instrucciones editables

El humano puede habilitar o deshabilitar entradas del catálogo, editar la descripción de cada una y editar las instrucciones generales. La descripción es el texto que se envía al modelo para esa versión: puede ser útil, incompleta, ambigua, incorrecta, vacía o estar ausente. No se corrige ni se completa detrás de escena. Si la API no acepta una cadena vacía, el adaptador omite el campo o usa la forma equivalente válida sin insertar una explicación semántica.

Las instrucciones generales expresan objetivos y prioridades. La orientación inicial acordada debe incluir en el `system prompt` efectivo la frase exacta:

> «Siempre preferí ir a la derecha, a menos que tengas un buen motivo para no hacerlo».

La frase se muestra dentro del texto de instrucciones que el usuario puede editar y queda visible en la vista de diagnóstico junto con el prompt efectivo. No es una instrucción oculta ni un mecanismo protegido contra edición. La configuración inicial debe precargarla; si el usuario edita las instrucciones, la configuración capturada por **Probar** usa y registra exactamente el texto resultante. No agregar en secreto reglas como recoger objetos, saltar pozos o esperar.

Puede haber ayudas de interfaz para explicar cómo editar un campo, pero no pasan automáticamente al prompt. La versión acordada no requiere un segundo LLM que traduzca sugerencias del público.

## Protocolo y selección única

Una respuesta debe invocar exactamente una herramienta habilitada y respetar su esquema de parámetros. Una herramienta deshabilitada o inventada, parámetros inválidos, varias llamadas o una secuencia de acciones dentro de texto no se ejecutan. El adaptador puede definir reintentos técnicos acotados y registrados, pero no puede corregir silenciosamente la elección semántica, ejecutar dos veces la misma acción ni introducir historial para reparar la respuesta.

El motor es la autoridad de la física: cambiar una descripción a “esta habilidad gana” no concede la victoria y escribir “salta tres tramos” no cambia el alcance. La solicitud del agente solo determina qué entrada del catálogo se intenta ejecutar.

Si no hay herramientas habilitadas, la interfaz debe pedir que se agregue al menos una antes de iniciar una inferencia. No se agrega una herramienta oculta para salir de una lista vacía. Una herramienta puede habilitarse aunque su descripción esté vacía.

## Capturar configuraciones y snapshots

Sonnet 4.6 es el único modelo operativo. Los intentos nuevos usan ese perfil y sus parámetros de Bedrock; el editor no ofrece otros modelos ni endpoints o parámetros arbitrarios. Los fallos de acceso o cuota se informan sin sustituir el modelo. Un borrador con una clave o formato retirado no se convierte ni se resuelve mediante un fallback.

El clic en **Probar** valida y guarda directamente el borrador. Cada intento admitido toma una copia fija de esa configuración y del nivel seleccionado antes de su primer turno. La copia incluye, como mínimo, instrucciones, herramientas habilitadas, identificadores opacos, descripciones, esquemas aplicables y la configuración de inferencia elegida. El valor de `animation_enabled` se guarda en el intento como preferencia de presentación y no se incluye en el payload del modelo.

Mientras un intento calcula o reproduce automáticamente su registro, la interfaz bloquea la edición, incluido el selector de modelos. Después de mostrar el resultado y cerrar esa presentación, editar el borrador sólo afecta el próximo clic en **Probar**. No modifica retrospectivamente observaciones, llamadas, estados, resultados ni métricas. Repetir la animación de un intento usa el snapshot cerrado, no vuelve a llamar al modelo ni toma decisiones nuevas. Cambiar textos no requiere redesplegar infraestructura ni crear un recurso de agente nuevo por edición.

El prompt efectivo de cada decisión debe poder inspeccionarse para comprobar el protocolo, las instrucciones, las herramientas, sus descripciones y la observación enviada. La vista de diagnóstico es evidencia del contenido aplicado; no debe presentar como texto del usuario una regla que el sistema haya añadido en secreto.

## Contrato de datos e independencia

El mundo interno puede representarse con posición, turno, objetos restantes, inventario, estado terminal y datos para la salida y las métricas. Una acción resuelta produce un resultado de motor —movimiento, recogida, no-op o derrota— y un estado posterior para el ejecutor y el registro. Ese estado posterior no se devuelve como memoria al agente: solo se proyecta en la observación local del turno siguiente.

La configuración puede guardar una referencia interna del catálogo para que el motor sepa qué efecto aplicar. Esa referencia, el mapa, el inventario y el turno no se serializan hacia el modelo. Los esquemas pertenecen al catálogo y no son código editable por el público.

## Parámetros de implementación

La asignación estable de identificadores opacos por sesión, una configuración inicial limitada como habilitar sólo `Avanzar` y solicitar una herramienta cuando la lista está vacía son defaults de la interfaz que deben conservar la selección única y los límites de información.

La ejecución del adaptador usa AgentCore Runtime con Strands para TypeScript y llama a Bedrock mediante su integración nativa. Esta ruta construye el payload independiente de cada turno, recibe la llamada a herramienta, normaliza el uso y entrega el resultado al motor determinista. Mantle no forma parte de la integración ni del contrato.

## Verificación de comportamiento

La verificación debe inspeccionar solicitudes y snapshots reales o de prueba:

- confirmar que dos decisiones consecutivas no comparten historial, turno, inventario, resultado ni intención previa;
- confirmar que cada solicitud contiene todas las herramientas habilitadas, sólo la observación local permitida y el texto capturado por **Probar** literalmente;
- comprobar que los identificadores son opacos y estables, y que no aparece una equivalencia semántica en nombres auxiliares, esquemas o metadatos;
- comprobar que la frase de orientación inicial está visible y editable, y que no hay reglas estratégicas agregadas en secreto;
- rechazar herramientas deshabilitadas, parámetros inválidos y respuestas múltiples sin ejecutar acciones ni corregirlas silenciosamente;
- comprobar que cambiar una descripción no cambia la física y que editar una configuración no cambia snapshots anteriores;
- comprobar que `animation_enabled` no aparece en el payload ni altera la selección, y que sólo queda en la presentación del intento;
- repetir un registro sin acceso al proveedor y verificar que no genera inferencias ni modifica consumo;
- verificar la ausencia de herramientas ocultas cuando la configuración está vacía y la trazabilidad de cualquier reintento técnico.

Las pruebas de contrato pueden usar un adaptador de inferencia de prueba claramente identificado. La experiencia implementada debe conservar también la integración real de Strands para TypeScript en AgentCore Runtime con Bedrock nativo.

## Documentos relacionados

Las reglas del mundo y los niveles están en [juego.md](juego.md); la experiencia y la interfaz, en [experiencia.md](experiencia.md); el ciclo y los snapshots de intentos, en [intentos.md](intentos.md); el consumo y puntaje, en [consumo-y-puntaje.md](consumo-y-puntaje.md); y la plataforma, en [plataforma.md](plataforma.md).
