# Juego y niveles

Este documento es canónico para las reglas del mundo, el reloj, las acciones, los objetos, la puerta, la salida y el contenido del nivel vigente. El contrato actual usa un único recorrido con terreno periódico, recompensa y llave recogibles, puerta y salida libre. La especificación vigente se distribuye en esta carpeta y se indexa desde [README.md](../../README.md).

Las etiquetas siguientes distinguen el grado de decisión:

- **Acordado:** comportamiento que la implementación debe conservar.
- **Default permitido:** elección inicial que puede adoptarse o cambiarse sin alterar las mecánicas.
- **Pendiente:** parámetro o contenido que se concreta durante la implementación y queda documentado al hacerlo.

## Recorrido principal vigente

El único nivel disponible es `principal-puerta-v4`, contenido versión 5, con `RULES_VERSION=4`. Sus diez tramos, en orden, son `ground`, `pit`, `ground`, `branch`, `barrier`, `platform`, `ground`, `ground`, `ground`, `ground`; tiene casillas 0–10 y un límite de 24 acciones. `recompensa-1` está en la casilla 2 y vale 25 puntos si se recoge. `llave-1` está en la casilla 6 y no aporta puntos. La puerta ocupa el acceso a la casilla 9 desde el 8; la salida libre está en la casilla 10.

La barrera está baja en turnos pares y alta en turnos impares. La plataforma conserva su ciclo de tres turnos y usa desfase uno: es suelo en los turnos con resto dos al dividir por tres y pozo en los demás. La barrera usa desfase cero. Así, la ruta que recoge la recompensa llega a la plataforma en el turno 6, con pozo; esperar en los turnos 6 y 7 permite cruzarla caminando en el 8. Saltar sigue siendo una alternativa válida. El nivel y las reglas se fijan en cada intento. Los intentos ya admitidos con el contenido versión 4 conservan sus fases originales para continuar, consultar decisiones y reproducirse fielmente. Los nuevos usan la versión 5. No se agregan otros recorridos ni lectores de contratos de reglas anteriores.

## Alcance del juego

El robot se desplaza por un recorrido lateral lógico formado por tramos y casillas. El agente decide una acción por turno y un motor determinista resuelve su efecto. La reproducción de un intento utiliza el registro cerrado de esa resolución; no vuelve a decidir ni cambia las reglas. El juego no incluye un robot físico, física libre, salto largo, inferencias por frame, entrenamiento del modelo ni un editor o generador obligatorio de niveles.

## Mundo lógico

Un nivel tiene `N` tramos ordenados y `N+1` casillas seguros. Los índices son internos al motor y no se envían al agente como coordenadas o identificadores.

- El robot comienza en la casilla 0 mirando a la derecha.
- Su posición lógica siempre es una casilla, nunca un tramo ocupado por un obstáculo.
- Desde la casilla `p`, avanzar cruza el tramo `p` y llega a `p+1`.
- Desde `p`, retroceder cruza el tramo `p-1` y llega a `p-1`.
- El casilla `N` contiene la salida.
- Los objetos se colocan en casillas.
- El terreno peligroso afecta el tramo que se cruza y no destruye las casillas. La puerta ocupa la entrada a la casilla 9: cerrada, impide el cruce desde la casilla 8 y deja al robot en ese casilla segura.

Una acción de movimiento cruza exactamente un tramo. Saltar o pasar agachado termina en la casilla del otro lado; el robot no queda detenido en un pozo. Saltar y pasar agachado tienen dirección izquierda o derecha. No existe una postura agachada persistente ni una acción separada para levantarse: cada movimiento se evalúa con su propia modalidad.

Todo movimiento intentado fija la orientación física del robot en esa dirección, incluso si encuentra un límite, la puerta cerrada o un obstáculo fatal y no cambia de casilla. Esperar, Nadar y Agarrar objeto conservan la orientación. La observación local informa esa orientación, sin añadir historial ni coordenadas.

## Acciones y direcciones

El catálogo de capacidades existe antes de iniciar el intento. Habilitar una habilidad solo agrega al agente una entrada de ese catálogo; no crea física nueva ni ejecuta código escrito por el usuario.

| Acción visible | Dirección o parámetros | Efecto del motor |
|---|---|---|
| Avanzar | implícitamente derecha | Cruza un tramo caminando hacia la casilla siguiente |
| Retroceder | implícitamente izquierda | Cruza un tramo caminando hacia la casilla anterior |
| Saltar | izquierda o derecha | Cruza un tramo por el aire |
| Agacharse y avanzar | izquierda o derecha | Cruza un tramo agachado |
| Esperar | ninguno | Conserva la casilla y deja pasar un turno |
| Agarrar objeto | ninguno | Intenta recoger un objeto de la casilla actual |

Caminar, saltar y pasar agachado comparten el sentido de las reglas de colisión en ambas direcciones. Retroceder caminando no sustituye la capacidad de saltar o agacharse para volver a cruzar un obstáculo. Una habilidad distractora, como nadar en un nivel sin agua, tiene un efecto determinista y normalmente es un no-op.

## Reloj y ciclos

Cada intento empieza en el turno 0. Para resolver una decisión, el motor:

1. deriva el estado de cada tramo para el turno `t`;
2. construye la observación local de ese estado;
3. recibe y valida una única llamada a una herramienta;
4. evalúa la acción usando exclusivamente el estado del inicio del turno;
5. cuenta un turno, registra el evento y, si el intento continúa, pasa a `t+1`.

Esperar, recoger un objeto y cualquier habilidad sin efecto consumen un turno igual que un movimiento. El turno de una caída o choque también se cuenta. Durante la evaluación de una acción una barrera conserva la fase usada por el motor; su cambio puede animarse entre acciones.

El terreno periódico se calcula desde el nivel y el turno evaluado:

```text
estado_del_tramo(i, t) = fases_i[(t + desfase_i) mod cantidad_de_fases_i]
```

En el nivel vigente, el tramo de barrera alterna entre `barrier_low` en turnos pares y `barrier_high` en impares. El tramo de plataforma es `ground` cuando `(t + 1) % 3 = 0` y `pit` en los demás turnos. El cálculo usa el turno inicial de la acción; el cambio se aplica al estado siguiente si el juego continúa.

El inventario persiste durante el intento y no cambia con las fases del terreno. Si un tramo cambia detrás del robot, la casilla en el que ya está permanece seguro. Esperar conserva la posición, pero puede cambiar el próximo obstáculo; ningún nivel debe asumir que esperar es obligatoria si existe otra solución válida.

## Matriz de colisiones

La compatibilidad depende del estado actual del tramo y de la modalidad de cruce, nunca del texto de la descripción de una herramienta.

| Estado del tramo | Caminar (avanzar o retroceder) | Saltar | Pasar agachado |
|---|---|---|---|
| Suelo libre | válido | válido | válido |
| Pozo | derrota por caída | válido | derrota por caída |
| Rama baja / obstáculo superior | derrota por choque | derrota por choque | válido |
| Barrera baja | derrota por choque | válido | derrota por choque |
| Barrera alta | derrota por choque | derrota por choque | válido |

Una acción de movimiento válida mueve exactamente un tramo en la dirección que indica. Saltar sobre suelo libre sigue siendo válido. Una colisión o caída termina el intento en esa acción. Una puerta cerrada impide entrar sin provocar caída ni derrota, aun si el agente intenta Saltar o Agacharse. El mismo resultado debe producirse para el mismo estado inicial y la misma acción.

## Límites y acciones sin efecto

En la casilla 0 no hay tramo a la izquierda; en la casilla `N` no hay tramo a la derecha. **Default permitido:** intentar salir del recorrido es un no-op que conserva posición e inventario, consume un turno y queda registrado. La observación local debe mostrar el límite explícitamente. Nunca se usan índices negativos, movimientos fuera del mapa ni la salida por un extremo como condición implícita de victoria.

Otros no-ops son esperar, intentar recoger sin objeto, intentar cruzar la puerta cerrada y usar una habilidad distractora donde no tiene efecto. Un no-op no es una colisión: no derrota al robot por sí mismo, aunque puede llevar a otro estado periódico al consumir el turno. Cada no-op genera un evento de reproducción y conserva el uso real de la llamada al modelo.

Los estados terminales de la simulación son:

| Estado | Causa |
|---|---|
| Victoria | Se llega a la casilla 10, que contiene la salida libre |
| Derrota | La acción de movimiento es incompatible con el obstáculo |
| Recorrido incompleto | Se alcanza el límite de turnos sin terminar |
| Cancelado | El humano interrumpe el cálculo |
| Error de ejecución | Falla el proveedor o la respuesta no cumple el contrato |

Cancelado y error de ejecución son resultados operativos y no derrotas del robot. No se ejecutan nuevas acciones después de un terminal. Si la acción del último turno llega a la salida, gana; si es fatal, pierde; la victoria no se reemplaza por el límite.

## Objetos, puerta y salida

El inventario empieza vacío. El nivel vigente contiene una recompensa y una llave. La salida nunca está bloqueada; la puerta anterior es el único acceso condicionado por un objeto.

Los objetos se recogen únicamente desde la casilla actual mediante `Agarrar objeto`. Pasar por una casilla no los recoge, y no se pueden recoger objetos remotos. Recoger consume un turno, mantiene al robot en la casilla, quita el objeto del suelo y lo agrega al inventario interno. La identidad del objeto impide recogerlo o puntuarlo dos veces. Intentarlo donde no queda un objeto es un no-op que también consume un turno.

El nivel vigente tiene como máximo un objeto por casilla, por lo que la acción no necesita seleccionar entre varios. No se agregan consumo, equipamiento, combinación, lanzamiento ni uso manual de objetos.

La llave abre automáticamente la puerta cuando entra al inventario; no se equipa ni se usa mediante otra herramienta. Al llegar a la casilla 8 sin ella, la observación del lado derecho identifica una puerta cerrada y el ID de la llave requerida, pero no indica dónde está. Intentar avanzar, saltar o pasar agachado hacia la casilla 9 queda registrado como `no_op/door_locked`, conserva la posición y consume un turno. Desde allí se puede retroceder dos casillas hasta encontrar la llave en el 6. Después de recogerla, el mismo acceso queda abierto y cualquiera de esos movimientos compatibles puede cruzarlo. La puerta no cambia la fase del terreno y no bloquea el retroceso desde una casilla seguro.

La salida de la casilla 10 no exige llave ni tiene estados de apertura. Llegar a ella después de cruzar el recorrido termina en victoria. La llave vale cero; sólo la recompensa recogida añade 25 puntos al puntaje de una victoria.

Las recompensas opcionales se ubican antes de la activación automática de la victoria. Los valores y requisitos son datos del nivel y se aplican solo a los objetos realmente recogidos en ese intento.

## Nivel vigente

El recorrido vigente es el definido arriba. No hay selector de nivel ni otro nivel activo. Las configuraciones guardadas del robot no contienen un nivel; se podrán recuperar cuando se incorporen otros recorridos en trabajos posteriores.

El nivel principal vigente presenta esta progresión:

- suelo libre;
- pozo;
- rama u obstáculo superior;
- la barrera periódica baja/alta;
- la plataforma periódica suelo/pozo.

La recompensa está en la casilla 2; la llave, en el 6; la puerta, en el acceso al 9; y la salida, en el 10.

Para cada nivel se debe verificar, además de que exista una ruta física, que una política basada en la observación actual y las herramientas disponibles pueda escogerla:

- no hay dos situaciones indistinguibles que requieran acciones opuestas por información ausente;
- no se necesita recordar que el robot está regresando ni el mapa global;
- el orden de los ciclos deja accesibles las transiciones;
- las casillas siguen siendo seguros entre fases;
- el límite de turnos permite una solución razonable y corta los bucles.

Un corredor vacío que exige volver sin una señal local es un nivel inválido para este agente. En el recorrido vigente, la puerta informa localmente que requiere `llave-1`; retroceder desde la casilla 8 lleva al 7 y luego al 6, donde la llave vuelve a ser observable. En la casilla 7, la orientación actual distingue el avance hacia la puerta del regreso desde ella, aunque los tramos vecinos sean iguales. El agente no recibe la ubicación remota ni un recuerdo de haberla visto. La calidad de sus decisiones depende también de las habilidades y descripciones que prepara el jugador.

## Defaults permitidos y pendientes

El contenido vigente fija los períodos y desfases descritos arriba, un límite de 24 acciones, el valor de 25 puntos de `recompensa-1` y el valor cero de `llave-1`. Los límites del recorrido y la puerta cerrada son no-op; las habilidades sin efecto tienen resolución determinista. La configuración inicial limitada y la frase de orientación se fijan en [agente.md](agente.md).

## Verificación de comportamiento

La verificación debe cubrir el comportamiento, no depender solo de que se dibuje el recorrido:

- probar la matriz de colisiones en ambas direcciones y las fases de barrera y plataforma, incluido el turno 0;
- comprobar que toda acción, no-op y acción fatal cuenta un turno en el orden correcto;
- comprobar que una fase nueva no hace caer a un robot que ya está en una casilla seguro;
- verificar victoria, derrota, límite, cancelación y error sin ejecutar una acción posterior;
- comprobar que el nivel principal tiene una solución dentro del límite con la observación local y las herramientas disponibles;
- reproducir los casos de no-op y de colisión como las causas registradas.

Verificar rutas victoriosas con y sin recompensa dentro del límite; la acción de recogida cambia el turno que se encuentra en barrera y plataforma. Comprobar que sólo el objeto local puede recogerse, que el inventario conserva su identidad sin duplicados y que el no-op por ausencia de objeto consume un turno. Una ruta debe pasar de largo la llave, encontrar la puerta cerrada, retroceder, recogerla, abrir la puerta y ganar en la salida; otra debe recogerla antes de llegar a la puerta. En ambos casos la salida queda libre.

Las pruebas pueden usar un adaptador de agente de prueba o un controlador de referencia para el motor. Eso sirve para validar reglas y resolución y no reemplaza la inferencia real requerida por la experiencia.

## Documentos relacionados

La experiencia visible se describe en [experiencia.md](experiencia.md); el ciclo y registro de intentos, en [intentos.md](intentos.md); las métricas y el puntaje, en [consumo-y-puntaje.md](consumo-y-puntaje.md); y las decisiones de plataforma, en [plataforma.md](plataforma.md).
