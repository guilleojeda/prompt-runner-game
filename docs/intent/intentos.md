# Intentos: ejecución, registro y reproducción

Estado: ejecución del nivel principal periódico con Sonnet 4.6, registro, consultas, Esperar, animación opcional y reproducción del contrato vigente.

Esta página define el ciclo de un intento desde que se fija la configuración hasta que se muestra su reproducción. Se relaciona con [la experiencia](experiencia.md), [las reglas del juego](juego.md), [el agente](agente.md) y [la plataforma](plataforma.md).

El diseño técnico está en [registro de ejecución](../architecture/registro-de-ejecucion.md) y [animación](../architecture/animacion.md). El cálculo, el registro y su reproducción usan `principal-periodico-v2`. El almacenamiento físico se documenta en [datos](../architecture/datos.md).

## Alcance y reglas que no cambian

Un intento es una ejecución independiente. Sonnet 4.6 y el perfil vigente quedan fijados al admitir. El agente no recibe memoria, resultados ni conversaciones de otros intentos. El aprendizaje entre intentos consiste en editar las habilidades, sus descripciones o las instrucciones y crear otro snapshot con **Probar**; no consiste en entrenar ni adaptar el modelo. Los registros del contrato vigente se consultan y reproducen; no se promete conservar lectores para contratos reemplazados.

El intento separa el cálculo de la presentación:

1. El ejecutor calcula todas las decisiones y resuelve el mundo con reglas deterministas.
2. Cuando el registro quedó cerrado, el sistema muestra el resultado de inmediato o, si `animation_enabled` está activo y hay acciones que presentar, reproduce la secuencia registrada antes del resultado.

Ambas rutas cierran y conservan el mismo registro. La reproducción no vuelve a consultar al modelo, no toma decisiones, no ejecuta acciones y no cambia el resultado ni las métricas.

La información del contrato vigente se conserva en el servidor, sin caducidad automática mientras ese contrato siga operativo. Incluye configuraciones aplicadas, el nivel usado, historial, registros reproducibles, resultados y métricas. Cada registro pertenece a un usuario y debe quedar aislado de los registros de otros usuarios. Los datos de prueba de contratos anteriores pueden eliminarse o permanecer sin uso si no interfieren; no se migran ni requieren lectores anteriores.

El cálculo se mantiene en el servidor. El job en curso, su snapshot, su registro y el valor de `animation_enabled` se conservan para que una recarga recupere el intento sin repetir inferencia ni crear otro intento.

## Inicio y fijación del intento

Antes de iniciar, la persona revisa el nivel principal vigente y edita el borrador de configuración del agente. Al hacer clic en **Probar**, el servidor valida y guarda directamente ese borrador; si admite el intento, toma una copia inmutable de:

- la definición y versión del nivel;
- las habilidades habilitadas, sus identificadores opacos, schemas y descripciones;
- las instrucciones generales y el prompt efectivo inspeccionable;
- la configuración de inferencia elegida;
- el límite de turnos;
- los parámetros de puntuación vigentes;
- el valor del toggle **Animación** para esa presentación.

Editar después el borrador no modifica esa copia ni ningún intento anterior. La copia fija permite reproducir el intento bajo el contrato vigente. Al reemplazar un contrato, no se conserva compatibilidad con sus registros. El valor de **Animación** se guarda para presentar ese intento y no modifica prompt, herramientas, llamadas, tokens, turnos, puntaje, cuota ni el registro.

Al crear el intento se reinicia el mundo con:

- posición inicial;
- turno 0;
- sin objetos en el nivel vigente;
- inventario vacío;
- estado inicial de la salida;
- contadores de turnos, llamadas y uso propios del intento.

Se reinicia el estado del mundo y los contadores, y no se arrastran memoria, resultados, snapshots del mundo, eventos ni conversaciones de otro intento. La persona sí puede seleccionar o reutilizar una configuración guardada; esa configuración se usa como fuente y se fija otra copia para el nuevo intento.

Si la validación, el guardado o la detección de conflicto falla antes de admitir el intento, no se crea un job de agente ni se consume cuota. El servidor conserva el borrador que la persona intentó probar y la interfaz vuelve a edición con la causa visible. Una vez admitido, el job conserva su snapshot y su registro aunque termine con cancelación o error de ejecución.

## Loop secuencial de decisiones

Cada turno produce como máximo una acción de juego. La siguiente decisión no puede calcularse antes de aplicar la acción actual porque depende del mundo resultante.

En cada decisión el ejecutor:

1. Comprueba que el intento no terminó y que todavía queda una acción permitida por el límite.
2. Guarda un snapshot del mundo antes de la decisión.
3. Construye la observación local correspondiente a ese estado: punto actual, tramo inmediato a la izquierda y tramo inmediato a la derecha, con sólo los datos autorizados.
4. Envía una solicitud nueva al modelo, sin historial ni estado de decisiones previas. Incluye el protocolo técnico, las instrucciones fijadas y todas las herramientas habilitadas, sin filtrar las que parecen compatibles con el obstáculo actual.
5. Valida que la respuesta seleccione exactamente una herramienta habilitada y que sus argumentos cumplan el schema. No se ejecuta una herramienta inventada, deshabilitada, mal formada o acompañada de varias acciones. Una secuencia escrita dentro de una descripción tampoco se interpreta como varias acciones.
6. Resuelve la única acción contra el estado del mundo del turno de inicio.
7. Cuenta un turno de juego, incluso si la acción fue esperar, no produjo cambios, llegó a un límite o resultó fatal. Recoger un objeto contará cuando se incorpore esa mecánica.
8. Evalúa el estado terminal en el orden definido abajo. Si el intento continúa, avanza el reloj periódico y construye el estado del turno siguiente.
9. Registra el evento completo y conserva el uso de la llamada o llamadas que produjeron esa decisión.

Una acción sin efecto no provoca una derrota por sí sola: consume el turno, queda registrada y permite continuar mientras no se alcance otra condición terminal.

La observación siguiente siempre se construye de nuevo. El agente no recibe el número de turno, las coordenadas globales, el mapa completo, el inventario completo, el puntaje acumulado, el historial de acciones ni los ciclos futuros. El mundo interno sí conserva posición, objetos, inventario y la fase de sus obstáculos.

El estado periódico de los obstáculos se calcula a partir del turno. Una acción usa la fase que corresponde al estado anterior de ese turno. Si la partida continúa, el estado posterior representa el turno siguiente; no se cambia una fase de manera retroactiva para justificar la acción. Un apoyo seguro no se vuelve peligroso por cambiar la fase de un tramo vecino.

La separación entre decisiones es estricta: no se pide un plan completo, no se devuelve un array de acciones para ejecutar de una vez y no se calculan turnos en paralelo.

### Orden de terminación

`turnos_utilizados` cuenta las acciones ejecutadas y empieza en cero. Antes de pedir una nueva decisión, si ya alcanzó el límite sin un estado terminal, el intento termina como recorrido incompleto y no se realiza otra llamada.

Después de ejecutar la acción final de un turno, se incrementa el contador y se evalúa:

1. Si hubo colisión o caída causada por una acción de movimiento incompatible, el resultado es derrota.
2. Si no hubo una causa fatal y se alcanzó una salida habilitada, el resultado es victoria.
3. Si no terminó por las razones anteriores y se alcanzó el límite, el resultado es recorrido incompleto.
4. En cualquier otro caso, el intento continúa con el turno siguiente.

Por eso la acción del último turno permitido sí se ejecuta: una victoria en ese turno es victoria y una colisión en ese turno es derrota. Un turno fatal se conserva en el registro aunque no haya un nuevo turno jugable después.

Los estados terminales son:

| Estado | Causa | ¿Se clasifica como solución? |
| --- | --- | --- |
| Victoria | Recorrido completado y salida habilitada | Sí |
| Derrota | Movimiento incompatible con un obstáculo, con colisión o caída | No |
| Recorrido incompleto | Límite de turnos alcanzado sin victoria ni derrota | No |
| Cancelado | Interrupción explícita de la persona durante el cálculo | No |
| Error de ejecución | Fallo del proveedor o respuesta que no cumple el contrato y no puede continuar | No |

Una interrupción o un fallo técnico no se presenta como derrota del robot. Los nombres concretos de los estados pueden variar en el código, pero deben conservar esta clasificación observable.

## Validación y reintentos técnicos

La validación del contrato ocurre antes de resolver la acción. Una respuesta inválida no cambia posición, inventario, reloj ni objetos y no cuenta como turno de juego. Tampoco se corrige silenciosamente el significado de la decisión: no se sustituye la herramienta, se ajustan argumentos ni se elige una acción plausible en su lugar.

El adaptador puede definir una política acotada de reintentos técnicos para fallos recuperables del proveedor o de transporte. El número y las condiciones concretas quedan para esa implementación; este documento no fija una cuota ni una cantidad inventada de reintentos. Un reintento técnico:

- permanece dentro de la misma decisión;
- no agrega memoria ni una conversación nueva al payload;
- no cuenta como turno ni ejecuta dos veces una acción;
- conserva el uso reportado por cada llamada realizada.

Si la política no obtiene una respuesta ejecutable, el intento termina como error de ejecución. La respuesta inválida, cada llamada de reintento, su resultado y su uso deben quedar auditables en el registro. Las llamadas que no informen uso no deben recibir un valor inventado.

## Registro del intento

El servidor conserva el registro del contrato vigente asociado al usuario sin plazo de caducidad automática mientras ese contrato siga operativo. Debe ser posible abrirlo más adelante, cargar la copia fija y reproducirla sin acceso al proveedor de inferencia.

El registro del intento contiene como mínimo:

| Dato | Contenido |
| --- | --- |
| Propietario | Usuario al que pertenece el intento, usado para aislar el acceso |
| Identificador | Identificador del intento |
| Nivel fijo | Versión o copia exacta del nivel utilizado |
| Configuración fija | Versión o copia de habilidades, schemas, descripciones, instrucciones y prompt efectivo |
| Inferencia | Modelo y parámetros utilizados |
| Límites y puntaje | Límite de turnos y parámetros de puntuación aplicados |
| Presentación | Valor de `animation_enabled` fijado al admitir el intento |
| Estado inicial | Snapshot del mundo con el que comenzó el intento |
| Eventos | Eventos ordenados de cada decisión y sus llamadas |
| Estado final | Snapshot final, estado terminal y causa de finalización |
| Métricas | Turnos utilizados, cantidad de llamadas y consumo de tokens. La métrica de objetos recogidos se agregará cuando exista esa mecánica. |
| Resultado | Puntaje, sólo cuando corresponde a un intento completado |

Cada evento debe conservar como mínimo:

- número interno de decisión y turno evaluado;
- snapshot exacto del mundo anterior a la decisión;
- observación exacta enviada al modelo;
- cada llamada de inferencia involucrada, incluyendo respuesta recibida, validación, error o reintento y uso informado;
- identificador opaco solicitado y argumentos;
- identidad interna de la acción real para el motor, el registro y la interfaz humana;
- resultado de la acción: movimiento válido, recogida, sin efecto o derrota;
- posición lógica de origen y destino cuando corresponda;
- estado de la salida modificado; objetos, cuando exista esa mecánica;
- motivo programático del no-op, choque, caída o error de validación;
- snapshot resultante del mundo, o el estado conservado si no se ejecutó una acción válida;
- datos de animación necesarios para representar una trayectoria, caída o choque, cuando no se puedan derivar sin ambigüedad;
- tokens y tiempo de inferencia de esa decisión, si el proveedor los informa.

El evento usa el turno de su estado anterior. Cuando la partida continúa, su estado posterior incluye el turno siguiente. En una finalización, la última acción sigue contando, pero no se crea una nueva fase jugable. El estado de los obstáculos utilizado para resolver la acción debe poder identificarse desde ese snapshot y la copia fija del nivel.

Cada snapshot representa al menos la posición, el turno, el estado del intento, el estado de la salida y los datos internos necesarios para resolver las acciones y las métricas. En el nivel vigente no hay objetos, el inventario está vacío y la salida siempre está habilitada. El motor deriva las fases de la copia fija del nivel y el turno y conserva sus estados efectivos en el snapshot; el reproductor los lee sin recalcular periodicidad, según el [contrato de registro](../architecture/registro-de-ejecucion.md).

Registrar el uso original del proveedor junto con los campos normalizados evita perder información cuando las categorías cambian entre APIs. La normalización y el cálculo del puntaje se detallan en [consumo y puntaje](consumo-y-puntaje.md).

## Reproducción fiel

La reproducción comienza sólo cuando el registro del intento está cerrado y los sprites y demás recursos necesarios están disponibles. No hace falta prerenderizar un video ni todos sus frames: el reproductor puede dibujar la secuencia a partir del registro cerrado.

El reproductor:

- ejecuta visualmente la secuencia registrada;
- usa la copia fija del nivel y la configuración del intento;
- no vuelve a llamar al modelo ni a decidir si una acción fue correcta;
- no recalcula colisiones para cambiar el resultado;
- no consume tokens ni altera contadores;
- no incorpora ediciones realizadas después;
- repite exactamente la secuencia lógica de acciones y estados, las causas registradas y el estado terminal guardados.

Durante cada animación se mantiene la fase de obstáculos que el motor utilizó para evaluar esa acción. El cambio de fase se dibuja entre acciones, al pasar al siguiente turno. Una caída puede tener una posición visual intermedia diferente del apoyo lógico de origen; se registra o deriva esa trayectoria para que el robot caiga y no vuelva artificialmente al apoyo.

Las animaciones que la experiencia necesita cubrir son:

- caminar a derecha e izquierda;
- saltar un tramo en ambas direcciones;
- pasar agachado un tramo en ambas direcciones;
- esperar;
- recoger un objeto;
- permanecer sin efecto para una habilidad que no produce cambios;
- caer por un pozo;
- chocar con una rama o barrera;
- llegar a la salida y ganar;
- cambiar de fase los obstáculos periódicos.

La animación avanza automáticamente, a una única velocidad fija y en el orden de los turnos, desde el comienzo hasta el final. El usuario no tiene controles de pausa, retroceso, avance, salto de turnos, reinicio ni velocidad. Después de mostrar el resultado puede iniciar otra visualización completa desde ese resultado o desde el historial; una vez iniciada, se reproduce con las mismas reglas y sin inferencia. «Replay manual» significa únicamente que la persona inicia esa visualización, no que controla su progreso.

## Estados del servidor y de la interfaz

El servidor conserva el estado del job y el registro; la interfaz conserva además el estado de presentación. Un job terminal no implica que la interfaz ya pueda mostrar el resultado: con `animation_enabled` activo puede quedar una animación automática pendiente o en curso.

El servidor debe poder distinguir, como mínimo, admisión pendiente, cálculo en curso y terminal con causa de victoria, derrota, límite, cancelación o error. También conserva el valor de `animation_enabled` y el registro cerrado. La interfaz puede estar en edición, guardando o admitiendo, cálculo, animación automática, resultado o replay manual; esos estados no se deben tratar como los mismos estados del job.

Durante el cálculo sólo **Cancelar** es operativo. Se bloquean edición, habilidades, toggle **Animación**, **Probar**, historial y reproducción. Durante cualquier animación se mantienen bloqueados edición, habilidades, toggle, **Probar** e historial y no hay controles de reproducción operativos. No se habilita edición hasta un estado terminal y el fin automático de la presentación.

Una cancelación o un error sin acciones ejecutadas cierra el resultado con su causa y no inicia una reproducción vacía. Si el registro cerrado contiene acciones, la reproducción automática sigue el valor de `animation_enabled`; el resultado se muestra después de ella si está activo y de inmediato si está desactivado. En ambos casos los replays posteriores desde el historial son manuales y no vuelven a inferir.

## Cálculo en curso y regreso a la aplicación

Mientras se calcula el intento, la interfaz muestra un estado claro como «Preparando intento». La duración del cálculo no es un criterio de rechazo ni bloquea la entrega; no se promete una latencia específica. Si la interfaz muestra detalles de progreso, puede mantenerlos discretos para no revelar el desenlace antes de la reproducción; ese tratamiento es una opción de presentación y no un criterio del intento.

El cálculo continúa en el servidor y una recarga recupera el intento en curso y el valor de `animation_enabled` guardado. Si el servidor informa cálculo, la interfaz vuelve a ese estado con los controles bloqueados y no crea otra inferencia ni otra cuota. Si informa un job terminal mientras la reproducción automática está pendiente, la interfaz recupera el registro cerrado, reproduce sin inferencia y mantiene bloqueados el resultado y la edición hasta terminar. Un registro sin acciones por cancelación o error muestra directamente su resultado con causa.

## Reinicio y aislamiento

Cada intento nuevo parte del estado inicial del nivel y del borrador que **Probar** admita. No reutiliza objetos recogidos, turnos, uso, estados del mundo, eventos ni decisiones de otro intento. El backend debe comprobar que el usuario sólo pueda leer y modificar sus configuraciones e intentos; un identificador recibido desde la interfaz no basta para cruzar esa frontera.

## Comprobaciones compactas

La implementación debe cubrir, como mínimo, estas comprobaciones de comportamiento:

- Resolver acciones válidas e incompatibles en ambas direcciones, espera, no-op, recogida, límites del mapa y cambios de fase, verificando que cada acción ejecutada consume un turno y que el snapshot usado coincide con el turno de inicio.
- Ejercitar victoria, derrota y límite en el último turno permitido, además de cancelación y error, verificando el orden de precedencia y que ningún fallo técnico se clasifique como derrota.
- Inspeccionar solicitudes para confirmar una herramienta por decisión, todas las habilitadas, observación local sin memoria y separación entre identificador opaco, descripción y efecto.
- Forzar una respuesta inválida y, si la política del adaptador incluye reintentos técnicos, un reintento recuperable para comprobar que no hay acción duplicada, que se conserva cada llamada y que el uso no se confunde con turnos.
- Cerrar un registro, reproducirlo sin proveedor y repetirlo, verificando que no hay inferencias nuevas, que editar una configuración no cambia el pasado y que la recuperación en servidor respeta el aislamiento entre usuarios.
- Verificar que cada visualización avanza de principio a fin a velocidad fija y sin controles para alterarla; habilitar otra visualización únicamente desde el resultado o el historial, después de terminar la anterior.
- Recorrer las reglas con un adaptador de prueba claramente identificado y completar al menos un recorrido con el proveedor real elegido. El adaptador de prueba sirve para proteger las reglas, pero no sustituye la inferencia real de la demostración.
