# Ejecución del juego y del agente

**Ejecución periódica del nivel principal con puerta y Sonnet 4.6.** AgentCore Runtime con Strands en TypeScript y Amazon Bedrock mediante su integración nativa reúne la coordinación del intento, el motor determinista y el registro. El nivel `principal-puerta-v4` conserva el resultado y permite consultar y reproducir intentos del contrato vigente. Sonnet 4.6 es el único modelo operativo. Los requisitos están en [la especificación](../../README.md#documentación-del-producto); Cognito usa su correo predeterminado inicialmente y SES se incorpora después; el frontend se publica en S3 privado mediante CloudFront con Origin Access Control, según [acceso y entrega](acceso-y-entrega.md).

## Componentes y responsabilidades

```mermaid
flowchart LR
  U[React en el navegador] --> C[Cognito: acceso]
  U --> W[HTTP API + Lambda web]
  W --> D[(DynamoDB)]
  W -->|invocación asíncrona| L[Lambda de arranque]
  L -->|inicio y reconocimiento breve| R[AgentCore Runtime: TypeScript + Strands]
  R --> D
  R --> S[(S3 privado: llamadas)]
  R --> B[Bedrock: Sonnet 4.6]
  W -->|lectura autorizada de metadatos| D
```

React sirve el editor, el estado del intento, su resultado, el historial y la reproducción con SVG. Lambda autentica solicitudes, controla pertenencia y cuota, guarda configuraciones y expone las consultas del intento y su proyección pública para replay. AgentCore Runtime ejecuta el motor determinista, construye observaciones, llama a Bedrock y guarda el resultado. DynamoDB es la autoridad del estado del intento; el navegador nunca decide movimientos, consumo ni puntos. Los cuerpos de inferencia se conservan en S3 privado según [datos](datos.md). La API no expone un endpoint de bodies o diagnóstico detallado. Para recuperar el uso, su rol puede leer objetos y comprobar su existencia únicamente en el bucket privado de inferencias. Una consulta no intenta recuperar la respuesta de una llamada aún activa; después del cierre o del vencimiento, un objeto ausente conserva el registro incompleto y un error real de S3 se informa como fallo de dependencia.

El [registro de ejecución](registro-de-ejecucion.md) define estados y resoluciones para reproducir sin importar el motor en el navegador. La [animación](animacion.md) y el renderer React/SVG presentan las acciones cerradas sin volver a llamar al modelo.

Esas responsabilidades son módulos TypeScript del mismo repositorio, no servicios por habilidad. El motor es una función determinista sin acceso a red. El catálogo tiene identidades internas, etiquetas humanas y herramientas opacas separadas. El adaptador de inferencia tiene una implementación Bedrock y un sustituto explícito para pruebas; no necesita una plataforma de proveedores intercambiables.

## Alojamiento, loop y framework

Runtime aloja un proceso TypeScript con el ejecutor del intento. Strands aporta el SDK de modelos, herramientas, eventos y hooks. La tarea de background permite seguir calculando sin navegador ni una Lambda esperando durante toda la partida. El motor, las transacciones y la cancelación conservan una única coordinación operativa.

Cada decisión usa una instancia de agente sin historial, solo las herramientas del juego y la observación actual. La respuesta completa se valida y registra antes de ejecutar un efecto. El loop se detiene tras una acción; la siguiente llamada corresponde a una observación nueva, nunca al resultado conversacional anterior. Los hooks y la instrumentación del proveedor deben verificar ese límite y conservar el uso original.

Se mantienen dos fundamentos de la selección: Harness con una invocación por decisión es viable y permite desactivar memoria, pero necesita otro ejecutor que coordine el juego y resuelva las funciones inline; el SDK directo evita el framework, pero exige mantener la integración que Strands permite reutilizar. Runtime con Strands reúne la coordinación y las funciones locales, con una dependencia mantenida para el agente. No se afirma un ahorro de inferencia medido ni incapacidad de las alternativas. Las capacidades están documentadas en [AgentCore y Strands](../reference/agentcore.md).

CodeZip Node.js y el SDK de Runtime alojan el ejecutor y su tarea de background. Strands es una librería dentro de ese proceso; no requiere desplegar otro servicio. La Lambda web conserva sus responsabilidades de API, identidad y cuota.

### Contrato operativo vigente del nivel principal

El único nivel vigente es `principal-puerta-v4`, versión 4, con `RULES_VERSION=4`. Sus diez tramos son `ground`, `pit`, `ground`, `branch`, `barrier`, `platform`, `ground`, `ground`, `ground`, `ground`; la salida libre está en el apoyo 10 y `maxTurns=24`. Contiene `recompensa-1` en el apoyo 2, con valor 25 al recogerla, y `llave-1` en el 6, con valor cero. La puerta está en el acceso al apoyo 9; desde el 8 impide el cruce si falta la llave, sin derrota. La barrera está baja en turnos pares y alta en impares; la plataforma es suelo si el turno es divisible por tres y pozo en los demás. La fase se calcula desde el turno inicial de cada acción, con desfase cero. El inventario determina si la puerta está abierta, sin otro campo persistido para ese estado.

El catálogo conserva `tool_1` Avanzar, `tool_2` Retroceder, `tool_3` Saltar, `tool_4` Agacharse y avanzar, `tool_5` Nadar, `tool_6` Esperar y `tool_7` Agarrar objeto. Esperar y Agarrar objeto no tienen argumentos y empiezan deshabilitadas; ambas consumen un turno sin mover al robot. Agarrar sólo recoge el objeto del apoyo actual y se registra como no-op cuando allí no queda ninguno. La observación contiene la orientación física actual (`facing`), los objetos del apoyo actual, el tramo inmediato a cada lado, una puerta local con estado y llave requerida o un límite, y el marcador de salida cuando corresponde; no expone coordenadas, inventario, ubicación remota de la llave ni fases futuras.

La configuración efectiva fija `RULES_VERSION=4`, `scoreVersion=score-v1`, el perfil único de Sonnet 4.6 y los parámetros de puntaje base 1000, peso de turno 10, peso de tokens 1, unidad 1000, dos decimales y negativos permitidos. El valor de cada objeto procede de la definición del nivel fijada en el intento: la recompensa aporta 25 puntos si está en el inventario final; la llave no aporta puntos. Los plazos operativos guardados son: inicio pendiente 5 minutos, evento de starter 5 minutos, vida de Runtime 30 minutos, llamada 60 segundos, reserva de guardado 30 segundos y margen de terminación 2 minutos. No son objetivos de latencia.

El Runtime registra una tarea asíncrona y el coordinador conserva snapshots de estado, llamadas y acciones en DynamoDB; los bodies completos de inferencia van a S3 privado. La continuidad al cerrar el navegador depende del proceso y de los registros persistidos. Una caída del proceso conserva lo ya escrito y cierra el intento como error; no hay reanudación automática del juego.

Para iniciar, una **Lambda breve invocada asíncronamente** llama a Runtime y espera solamente su reconocimiento. Se usa la cola administrada de esa modalidad de Lambda. La alternativa directa —Lambda web llama a Runtime— elimina una función, pero expone la petición web al arranque frío de Runtime y al límite de integración HTTP de 30 segundos. Con diez concurrencias Lambda observadas, retener peticiones mientras arranca el agente tampoco es una base demostrada para el pico esperado. La función de arranque desacopla esos tiempos sin incorporar SQS, Step Functions ni un sistema general de trabajos.

## Recorrido completo

El circuito actualmente implementado es:

1. El usuario recupera su borrador, edita habilidades e instrucciones, ajusta la preferencia de Animación y pulsa «Probar». No hay selector de modelo ni nivel; se usa Sonnet 4.6 y el único nivel vigente. La admisión fija el valor vigente de `animationEnabled` para ese intento.
2. La interfaz captura el borrador visible y la versión confirmada. La API valida identidad, versión, catálogo, tamaño y al menos una habilidad habilitada. Un rechazo previo conserva el borrador y no consume cuota.
3. Una transacción de DynamoDB crea el intento pendiente, guarda el snapshot inicial, la configuración completa del nivel/modelo/puntaje y el contador diario. La admisión y el despacho del starter no son una transacción atómica.
4. La API invoca asíncronamente la Lambda de starter. El starter valida el intento pendiente, invoca el Runtime y devuelve sólo el reconocimiento del despacho. Runtime reclama el intento con un ejecutor y crea su tarea asíncrona.
5. Cada decisión construye una observación local nueva, persiste el request antes del envío, ejecuta una llamada Bedrock, persiste el response completo y su uso, valida una única herramienta y aplica el motor periódico. La acción y el snapshot posterior se publican con condiciones de ejecutor y secuencia.
6. El cierre conserva resultado, causa, último snapshot, llamadas y métricas. La puntuación sólo se calcula para una victoria con `gameTokens` conocido; los demás estados conservan avance y métricas sin puntaje.
7. React consulta el resumen del intento y permite cancelar mientras calcula. Cuando cierra, muestra el resultado directamente si Animación estaba desactivada o si no hubo acciones; en caso contrario reproduce el registro con un único reloj y después marca la presentación terminada. El resultado y el historial ofrecen replay manual de intentos con acciones. Al cerrar o recargar, el navegador vuelve a consultar el mismo intento; el replay no crea una inferencia nueva.

La aprobación de una cancelación o el cierre por error impide nuevas acciones. Una llamada ya autorizada puede terminar y conservar su uso antes del cierre; DynamoDB, S3 y Bedrock no comparten una transacción. Una escritura tardía no reabre un intento cerrado. La definición de autorización, pertenencia y transiciones está en [experiencia](../intent/experiencia.md) e [intentos](../intent/intentos.md).

### Fases posteriores

La fase 8 incorporará diagnóstico de prompts y responses; las fases 9 y 10, comparación y recorrido de transferencia. No forman parte del nivel principal vigente.

## Inferencia

La integración usa **`BedrockModel` de Strands 1.18.0 y Converse sin streaming** para Sonnet 4.6, desde `us-east-1` y con credenciales IAM. Sonnet 4.6 es el único perfil operativo. No hay APIs directas de fabricantes, Mantle, claves API nuevas o descubrimiento de modelos durante cada intento. Sonnet 5, GPT-5.6 Sol y Opus 5/5.5 se implementarán en fase 12, después de SES; GPT-6 Luna/Sol siguen diferidos. El cliente AWS fija `maxAttempts=1`.

| Modelo | Perfil global | Salida máxima | Razonamiento y herramientas |
|---|---|---:|---|
| Claude Sonnet 4.6 | `global.anthropic.claude-sonnet-4-6` | 512 | Thinking omitido, desactivado por el contrato del modelo; `any`. |

Los intentos nuevos usan Sonnet 4.6 y fijan el perfil efectivo en su snapshot. El formato vigente de borrador admite únicamente este perfil. Otros valores se rechazan sin conversión ni asignación automática de otro modelo. Los límites son parámetros técnicos guardados por intento. No se envían temperature ni controles de caché sin necesidad; la omisión de un override queda registrada como omisión, sin inventar el valor efectivo del servicio.

Cada intento guarda el perfil completo y versionado; el ejecutor usa ese snapshot aunque cambien los defaults. La identidad efectiva también queda en cada llamada, porque Converse incluye el modelo en la ruta HTTP y no en el body. La disponibilidad documental no acredita permisos, cuota o inferencia exitosa en la cuenta. Véanse [Bedrock](../reference/bedrock.md) y [Strands](../reference/agentcore.md#strands-dentro-de-runtime).

Cada decisión usa protocolo mínimo, instrucciones literales, todas las herramientas capturadas y observación local. Se solicita `toolChoice=any`; eso no sustituye la validación de exactamente una acción. Bloques de texto como respuesta o plan, bloques desconocidos, cero o varias herramientas y truncamiento son errores. La respuesta se valida para exigir una única llamada habilitada y argumentos del schema antes de ejecutar cualquier efecto. Una respuesta inválida queda registrada y termina con error; no se corrige ni se ejecuta parcialmente. No se envían resultados de herramientas ni historial en otra llamada. Una descripción vacía se omite sin completarla.

La captura de request/response usa un `requestHandler` auditado: guarda el body efectivo antes del envío y el body completo antes de reducirlo a uso/acción. Una respuesta truncada, incompleta o semánticamente inválida no ejecuta una acción. Los tokens normalizados conservan entrada, salida, caché, `reasoningTokens` y `gameTokens` sin sumar dos veces categorías. Reasoning es un detalle incluido en salida; su ausencia queda desconocida y no invalida un total de entrada/salida inequívoco. No se asume que tokens equivalgan a bytes. La implementación actual no agrega una continuación conversacional ni un reintento oculto del SDK; se permiten como máximo dos reintentos adicionales ante throttling inequívoco, con un registro por envío. No se reintentan cortes ambiguos, timeout ni respuestas semánticamente inválidas.

El request y response efectivos se conservan antes de cualquier reducción a eventos o métricas normalizadas de Strands. Los hooks del agente por sí solos no se consideran prueba de captura íntegra del body del proveedor; la instrumentación del cliente de inferencia es la autoridad del registro local.

El acceso, la cuota y el acuerdo del modelo siguen requiriendo comprobación del ambiente antes de afirmar una ejecución real. La [observación de cuenta](../reference/cuenta-aws.md) conserva lecturas previas y no sustituye esa comprobación. No hay fallback automático ni cambio oculto de modelo dentro de un intento.

## Duplicados, fallos y continuidad

La clave de idempotencia se crea antes del primer envío. Repetirla con el mismo contenido recupera el mismo intento; usarla con otro contenido, incluido un cambio en la configuración o en Animación, produce conflicto. La recuperación de una clave existente precede a nueva cuota o validación del borrador. La asociación se conserva con los datos, no depende de los diez minutos de deduplicación del token transaccional de DynamoDB. Duplicados de HTTP, Lambda o Runtime convergen en el mismo claim. No se transfiere el claim ni se reanuda automáticamente un proceso perdido.

Guardar la admisión y despachar Lambda **no es atómico**. Si se pierde un reconocimiento, la UI puede reenviar el inicio del mismo intento sin otra cuota. Hay una fecha límite de inicio documentada y configurable: al vencer, una transición condicional cierra un pendiente como error y bloquea arranques tardíos. El backend distingue un despacho no confirmado de un rechazo anterior a la admisión. No promete que toda admisión sobrevivirá cualquier caída sin intervención.

Una tarea de Runtime sigue viva tras desconectar el navegador gracias al registro de actividad del SDK. Eso no proporciona durabilidad ante una caída del proceso. Si se pierde, se conserva lo obtenido y se informa error. El cierre por abandono técnico usa una fecha conservadora basada en el máximo de vida configurado de Runtime y su margen de terminación, no una mera falta reciente de progreso. Se materializa al consultar el intento; no necesita un vigilante permanente. Una escritura tardía no puede modificar un intento cerrado.

Los límites de inicio, vida de sesión y llamada son parámetros operativos versionados, elegidos al integrar el servicio; no objetivos de velocidad de la experiencia. No se inicia otra llamada cuando no queda margen para completarla y guardar su respuesta dentro de la vida del ejecutor. Los timeouts efectivos deben permitir que el cierre distinga llamada pendiente de llamada rechazada.

Los reintentos automáticos ocultos del SDK de inferencia se desactivan y el cliente fija un solo intento de transporte. El diseño aprobado permite hasta dos reintentos adicionales sólo por throttling inequívoco, con ordinal y uso propios; esa política sigue separada de cualquier retry de escritura y debe quedar explícita en el coordinador antes de presentarse como comportamiento verificado. Una respuesta semánticamente inválida termina con error; no se corrige ni se vuelve a preguntar con contexto adicional. Un timeout o corte de transporte cuyo procesamiento sea incierto termina con uso desconocido para esa llamada. Reintentar una escritura de los mismos bytes o consultar una transacción ambigua no vuelve a llamar al modelo.

## Cancelación y concurrencia

Cancelar pendiente cierra el intento y evita su claim. Cancelar en curso registra una solicitud: impide iniciar otra llamada o publicar otra acción, pero permite guardar la respuesta y el uso de la llamada en vuelo antes del cierre. La UI indica «Cancelando» mientras corresponde. No se mata normalmente la sesión antes de recibir ese uso.

La frontera de una llamada en vuelo es su registro previo condicionado a que no haya cancelación. Una llamada autorizada antes de cancelar puede terminar y consumir tokens aunque el envío de red coincida con la cancelación; DynamoDB y Bedrock no comparten una transacción. Se informa ese consumo y no se publica su acción si la cancelación ganó la carrera.

La carrera entre cancelar y publicar una acción se resuelve con condiciones en DynamoDB: si la acción se publicó primero, cuenta; si la cancelación se aceptó primero, esa acción no se publica. Una victoria ya cerrada no cambia a cancelación. Un proceso perdido durante cancelación conserva el resultado técnico real y la solicitud, sin inventar una confirmación del ejecutor.

Cada intento tiene un único ejecutor, pero no se impone un nuevo límite de un intento activo por usuario. Dos inicios distintos consumen dos lugares de la cuota; dos envíos del mismo inicio consumen uno. Borradores usan control de versión para que una segunda pestaña no sobrescriba silenciosamente una edición más reciente.

## Costo y comprobación necesaria

El consumo por intento depende de llamadas, entrada reenviada y salida real. Se conserva uso original y componentes normalizados sin duplicar caché. La tarifa opcional de inferencia se versiona; no se promete gasto mensual ni costo cero de infraestructura. Los límites de turnos y salida, la cuota y la ausencia de llamadas durante replay acotan trabajo concreto sin agregar un corte global de gasto no solicitado.

La verificación del contrato vigente cubre el nivel y las reglas periódicas, Esperar, preferencia entre sesiones, presentación opcional, reproducción del registro vigente, cierre sin acciones y ausencia de llamadas al modelo durante replay. La carga de cien usuarios pertenece a una fase posterior. La comprobación desplegada debe vincular versión, ambiente, intentos y cuota; no se infiere capacidad a partir de una tabla AWS ni se inventa una latencia objetivo.
