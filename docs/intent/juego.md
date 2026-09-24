# Juego y niveles

Este documento es canónico para las reglas del mundo, el reloj, las acciones, los objetos, la salida y el contenido de niveles del juego. El contrato vigente usa un único nivel principal con terreno periódico, movimientos y Esperar. Objetos, llaves y el recorrido de transferencia pertenecen a fases posteriores. La especificación vigente se distribuye en esta carpeta y se indexa desde [README.md](../../README.md).

Las etiquetas siguientes distinguen el grado de decisión:

- **Acordado:** comportamiento que la implementación debe conservar.
- **Default permitido:** elección inicial que puede adoptarse o cambiarse sin alterar las mecánicas.
- **Pendiente:** parámetro o contenido que se concreta durante la implementación y queda documentado al hacerlo.

## Recorrido principal vigente

El único nivel disponible es `principal-periodico-v2`, versión 2, con `RULES_VERSION=2`. Sus siete tramos, en orden, son `ground`, `pit`, `ground`, `branch`, `barrier`, `platform`, `ground`; tiene ocho apoyos, la salida está en el apoyo 7 y el límite inicial es de 16 acciones. No contiene objetos ni requisitos de salida.

La barrera está baja en turnos pares y alta en turnos impares. La plataforma es suelo en los turnos divisibles por tres y pozo en los demás. Ambas usan desfase cero desde el turno 0. El nivel y las reglas se fijan en cada intento. Este contenido no promete lectores para niveles ni registros de contratos anteriores; los datos de prueba anteriores pueden borrarse o quedar sin uso si no interfieren con el contrato vigente.

## Alcance del juego

El robot se desplaza por un recorrido lateral lógico formado por tramos y puntos de apoyo. El agente decide una acción por turno y un motor determinista resuelve su efecto. La reproducción de un intento utiliza el registro cerrado de esa resolución; no vuelve a decidir ni cambia las reglas. El juego no incluye un robot físico, física libre, salto largo, inferencias por frame, entrenamiento del modelo ni un editor o generador obligatorio de niveles.

## Mundo lógico

Un nivel tiene `N` tramos ordenados y `N+1` puntos de apoyo seguros. Los índices son internos al motor y no se envían al agente como coordenadas o identificadores.

- El robot comienza en el apoyo 0.
- Su posición lógica siempre es un apoyo, nunca un tramo ocupado por un obstáculo.
- Desde el apoyo `p`, avanzar cruza el tramo `p` y llega a `p+1`.
- Desde `p`, retroceder cruza el tramo `p-1` y llega a `p-1`.
- El apoyo `N` contiene la salida.
- Los objetos se colocan en apoyos.
- Los obstáculos afectan el tramo que se cruza y no ocupan ni destruyen los apoyos.

Una acción de movimiento cruza exactamente un tramo. Saltar o pasar agachado termina en el apoyo del otro lado; el robot no queda detenido en un pozo. Saltar y pasar agachado tienen dirección izquierda o derecha. No existe una postura agachada persistente ni una acción separada para levantarse: cada movimiento se evalúa con su propia modalidad.

## Acciones y direcciones

El catálogo de capacidades existe antes de iniciar el intento. Habilitar una habilidad solo agrega al agente una entrada de ese catálogo; no crea física nueva ni ejecuta código escrito por el usuario.

| Acción visible | Dirección o parámetros | Efecto del motor |
|---|---|---|
| Avanzar | implícitamente derecha | Cruza un tramo caminando hacia el apoyo siguiente |
| Retroceder | implícitamente izquierda | Cruza un tramo caminando hacia el apoyo anterior |
| Saltar | izquierda o derecha | Cruza un tramo por el aire |
| Agacharse y avanzar | izquierda o derecha | Cruza un tramo agachado |
| Esperar | ninguno | Conserva el apoyo y deja pasar un turno |
| Agarrar objeto | fase posterior | Intenta recoger un objeto del apoyo actual |

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

En el nivel vigente, el tramo de barrera alterna entre `barrier_low` en turnos pares y `barrier_high` en impares. El tramo de plataforma es `ground` cuando `t % 3 = 0` y `pit` en los demás turnos. El cálculo usa el turno inicial de la acción; el cambio se aplica al estado siguiente si el juego continúa.

Cuando se incorpore la mecánica de objetos, el inventario persistirá durante el intento y no cambiará con las fases del terreno. Si un tramo cambia detrás del robot, el apoyo en el que ya está permanece seguro. Esperar conserva la posición, pero puede cambiar el próximo obstáculo; ningún nivel debe asumir que esperar es obligatoria si existe otra solución válida.

## Matriz de colisiones

La compatibilidad depende del estado actual del tramo y de la modalidad de cruce, nunca del texto de la descripción de una herramienta.

| Estado del tramo | Caminar (avanzar o retroceder) | Saltar | Pasar agachado |
|---|---|---|---|
| Suelo libre | válido | válido | válido |
| Pozo | derrota por caída | válido | derrota por caída |
| Rama baja / obstáculo superior | derrota por choque | derrota por choque | válido |
| Barrera baja | derrota por choque | válido | derrota por choque |
| Barrera alta | derrota por choque | derrota por choque | válido |

Una acción de movimiento válida mueve exactamente un tramo en la dirección que indica. Saltar sobre suelo libre sigue siendo válido. Una colisión o caída termina el intento en esa acción. El mismo resultado debe producirse para el mismo estado inicial y la misma acción.

## Límites y acciones sin efecto

En el apoyo 0 no hay tramo a la izquierda; en el apoyo `N` no hay tramo a la derecha. **Default permitido:** intentar salir del recorrido es un no-op que conserva posición e inventario, consume un turno y queda registrado. La observación local debe mostrar el límite explícitamente. Nunca se usan índices negativos, movimientos fuera del mapa ni la salida por un extremo como condición implícita de victoria.

Otros no-ops son esperar, intentar recoger sin objeto y usar una habilidad distractora donde no tiene efecto. Un no-op no es una colisión: no derrota al robot por sí mismo, aunque puede llevar a otro estado periódico al consumir el turno. Cada no-op genera un evento de reproducción y conserva el uso real de la llamada al modelo.

Los estados terminales de la simulación son:

| Estado | Causa |
|---|---|
| Victoria | Se completa el recorrido y la salida cumple sus requisitos |
| Derrota | La acción de movimiento es incompatible con el obstáculo |
| Recorrido incompleto | Se alcanza el límite de turnos sin terminar |
| Cancelado | El humano interrumpe el cálculo |
| Error de ejecución | Falla el proveedor o la respuesta no cumple el contrato |

Cancelado y error de ejecución son resultados operativos y no derrotas del robot. No se ejecutan nuevas acciones después de un terminal. Si la acción del último turno habilita la salida, gana; si es fatal, pierde; la victoria no se reemplaza por el límite.

## Objetos, inventario y salida en fases posteriores

El nivel vigente no contiene objetos, el inventario empieza y permanece vacío, y la salida está habilitada desde el inicio. La mecánica de objetos se incorporará en una fase posterior.

Cuando se incorpore, los objetos se recogerán únicamente desde el apoyo actual mediante `Agarrar objeto`. Pasar por un apoyo no los recogerá, y no se podrán recoger objetos remotos. Recoger consumirá un turno, mantendrá al robot en el apoyo, quitará el objeto del suelo y lo agregará al inventario interno. La identidad del objeto impedirá recogerlo o puntuarlo dos veces.

**Default permitido:** como máximo un objeto por apoyo, para que la acción no necesite seleccionar entre varios. Si el contenido adopta más de uno, debe existir una selección inequívoca y visible. No se agregan consumo, equipamiento, combinación, lanzamiento ni uso manual de objetos.

Un objeto puede ser:

- un requisito de salida, como una llave;
- una recompensa con valor para el puntaje;
- ambas cosas.

La llave habilita automáticamente una salida que la requiera; no existe una acción adicional para usarla. Una salida sin requisitos está habilitada desde el principio. Llegar a una salida bloqueada no gana ni derrota: el intento puede continuar, incluso retroceder. La victoria ocurre al llegar a una salida habilitada o al obtener, estando en la salida, el requisito que faltaba. El estado visible de la salida puede indicar si está habilitada sin enviar el inventario completo al agente.

Las recompensas opcionales se ubican antes de la activación automática de la victoria. Los valores y requisitos son datos del nivel y se aplican solo a los objetos realmente recogidos en ese intento.

## Niveles y transferencia

El recorrido principal vigente es el definido arriba. Un recorrido corto de transferencia se incorporará en una fase posterior y combinará las mecánicas disponibles entonces. No hay selector de nivel ni otro nivel activo.

El nivel principal vigente presenta esta progresión:

- suelo libre;
- pozo;
- rama u obstáculo superior;
- la barrera periódica baja/alta;
- la plataforma periódica suelo/pozo.

La ubicación exacta de objetos, recompensas y llaves se definirá cuando se incorporen esas mecánicas. El recorrido de transferencia reordenará o combinará las mecánicas disponibles en una situación nueva; no requiere generación procedural.

Para cada nivel se debe verificar, además de que exista una ruta física, que una política basada en la observación actual y las herramientas disponibles pueda escogerla:

- no hay dos situaciones indistinguibles que requieran acciones opuestas por información ausente;
- no se necesita recordar que el robot está regresando ni el mapa global;
- el orden de los ciclos deja accesibles las transiciones;
- los apoyos siguen siendo seguros entre fases;
- el límite de turnos permite una solución razonable y corta los bucles.

Un corredor vacío que exige volver muchos apoyos sin una señal local es un nivel inválido para este agente. Un retorno corto ante una salida bloqueada y una llave en el apoyo anterior sí puede ser válido porque la razón está localmente disponible. La resolubilidad y la calibración pedagógica se ajustan durante la implementación; no son bloqueos nuevos para comenzar.

## Defaults permitidos y pendientes

El contenido vigente fija los períodos y desfases descritos arriba y un límite de 16 acciones. Los límites del recorrido son no-op y las habilidades sin efecto tienen resolución determinista. La configuración inicial limitada y la frase de orientación se fijan en [agente.md](agente.md). Los objetos, el recorrido de transferencia y sus valores se definirán en fases posteriores.

## Verificación de comportamiento

La verificación debe cubrir el comportamiento, no depender solo de que se dibuje el recorrido:

- probar la matriz de colisiones en ambas direcciones y las fases de barrera y plataforma, incluido el turno 0;
- comprobar que toda acción, no-op y acción fatal cuenta un turno en el orden correcto;
- comprobar que una fase nueva no hace caer a un robot que ya está en un apoyo seguro;
- verificar victoria, derrota, límite, cancelación y error sin ejecutar una acción posterior;
- comprobar que el nivel principal tiene una solución dentro del límite con la observación local y las herramientas disponibles;
- reproducir los casos de no-op y de colisión como las causas registradas.

La recogida de objetos y el recorrido de transferencia se verificarán cuando se implementen en sus fases posteriores.

Las pruebas pueden usar un adaptador de agente de prueba o un controlador de referencia para el motor. Eso sirve para validar reglas y resolución y no reemplaza la inferencia real requerida por la experiencia.

## Documentos relacionados

La experiencia visible se describe en [experiencia.md](experiencia.md); el ciclo y registro de intentos, en [intentos.md](intentos.md); las métricas y el puntaje, en [consumo-y-puntaje.md](consumo-y-puntaje.md); y las decisiones de plataforma, en [plataforma.md](plataforma.md).
