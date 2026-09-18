# Juego y niveles

Este documento es canónico para las reglas del mundo, el reloj, las acciones, los objetos, la salida y el contenido de niveles del juego. Documenta el comportamiento acordado; todavía no hay una implementación. La especificación vigente se distribuye en esta carpeta y se indexa desde [README.md](../../README.md). La especificación histórica [idea-inicial.md](../../idea-inicial.md) queda como antecedente.

Las etiquetas siguientes distinguen el grado de decisión:

- **Acordado:** comportamiento que la implementación debe conservar.
- **Default permitido:** elección inicial que puede adoptarse o cambiarse sin alterar las mecánicas.
- **Pendiente:** parámetro o contenido que se concreta durante la implementación y queda documentado al hacerlo.

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
| Esperar | ninguno | Conserva apoyo e inventario y deja pasar un turno |
| Agarrar objeto | según el catálogo | Intenta recoger un objeto del apoyo actual |

Caminar, saltar y pasar agachado comparten el sentido de las reglas de colisión en ambas direcciones. Retroceder caminando no sustituye la capacidad de saltar o agacharse para volver a cruzar un obstáculo. Una habilidad distractora, como nadar en un nivel sin agua, tiene un efecto determinista y normalmente es un no-op.

## Reloj y ciclos

Cada intento empieza en el turno 0. Para resolver una decisión, el motor:

1. deriva el estado de cada tramo para el turno `t`;
2. construye la observación local de ese estado;
3. recibe y valida una única llamada a una herramienta;
4. evalúa la acción usando exclusivamente el estado del inicio del turno;
5. cuenta un turno, registra el evento y, si el intento continúa, pasa a `t+1`.

Esperar, recoger un objeto y cualquier habilidad sin efecto consumen un turno igual que un movimiento. El turno de una caída o choque también se cuenta. Durante la evaluación de una acción una barrera conserva la fase usada por el motor; su cambio puede animarse entre acciones.

El terreno periódico se deriva de los datos del nivel y del turno, por ejemplo:

```text
estado_del_tramo(i, t) = fases_i[(t + desfase_i) mod cantidad_de_fases_i]
```

La fórmula expresa la regla, no un formato obligatorio de datos. Como ejemplos acordados de contenido, evaluados con el estado del turno actual, una barrera que sube y baja está baja en los turnos pares y alta en los impares; una plataforma periódica es suelo en los turnos múltiplos de tres y pozo en los turnos restantes. Los períodos dos y tres de esos ejemplos no fijan todos los obstáculos ni todos los mapas: los niveles concretos siguen siendo editables. Un desfase cero es un **default permitido**, no un valor definitivo.

Los objetos recogidos y el inventario son persistentes durante el intento y no se recrean cuando cambia la fase de un ciclo. Si un tramo cambia detrás del robot, el apoyo en el que ya está permanece seguro. Esperar conserva posición e inventario, pero puede cambiar el próximo obstáculo; ningún nivel debe asumir que esperar es obligatoria si existe otra solución válida.

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

## Objetos, inventario y salida

Los objetos se recogen únicamente desde el apoyo actual mediante `Agarrar objeto`. Pasar por un apoyo no los recoge, y no se pueden recoger objetos remotos. Recoger consume un turno, mantiene al robot en el apoyo, quita el objeto del suelo y lo agrega al inventario interno. La identidad del objeto impide recogerlo o puntuarlo dos veces.

**Default permitido:** como máximo un objeto por apoyo, para que la acción no necesite seleccionar entre varios. Si el contenido adopta más de uno, debe existir una selección inequívoca y visible. No se agregan consumo, equipamiento, combinación, lanzamiento ni uso manual de objetos.

Un objeto puede ser:

- un requisito de salida, como una llave;
- una recompensa con valor para el puntaje;
- ambas cosas.

La llave habilita automáticamente una salida que la requiera; no existe una acción adicional para usarla. Una salida sin requisitos está habilitada desde el principio. Llegar a una salida bloqueada no gana ni derrota: el intento puede continuar, incluso retroceder. La victoria ocurre al llegar a una salida habilitada o al obtener, estando en la salida, el requisito que faltaba. El estado visible de la salida puede indicar si está habilitada sin enviar el inventario completo al agente.

Las recompensas opcionales se ubican antes de la activación automática de la victoria. Los valores y requisitos son datos del nivel y se aplican solo a los objetos realmente recogidos en ese intento.

## Niveles y transferencia

El motor debe incluir un recorrido principal y un recorrido corto de transferencia. Ambos deben combinar las mismas mecánicas y ser resolubles con la observación local permitida; la ubicación exacta, la longitud, los períodos concretos, los objetos y el límite numérico son **pendientes** y deben quedar como datos fáciles de ajustar.

El recorrido principal debe presentar una progresión legible y representar en su contenido de demostración, en una combinación que resulte resoluble:

- suelo libre;
- pozo;
- rama u obstáculo superior;
- barrera que alterna entre baja y alta;
- plataforma que cambia según el turno;
- al menos un objeto recogible;
- una recompensa que intervenga en el puntaje;
- un caso de llave y salida bloqueada cuando el recorrido use esa mecánica.

El recorrido de transferencia reordena o combina las mecánicas en una situación nueva. Su objetivo es comprobar que una configuración útil se aplica a otro recorrido, no multiplicar niveles ni exigir generación procedural.

Para cada nivel se debe verificar, además de que exista una ruta física, que una política basada en la observación actual y las herramientas disponibles pueda escogerla:

- no hay dos situaciones indistinguibles que requieran acciones opuestas por información ausente;
- no se necesita recordar que el robot está regresando ni el mapa global;
- los objetos necesarios aparecen en apoyos alcanzables antes de necesitarlos;
- el orden de los ciclos deja accesibles las transiciones;
- los apoyos siguen siendo seguros entre fases;
- el límite de turnos permite una solución razonable y corta los bucles.

Un corredor vacío que exige volver muchos apoyos sin una señal local es un nivel inválido para este agente. Un retorno corto ante una salida bloqueada y una llave en el apoyo anterior sí puede ser válido porque la razón está localmente disponible. La resolubilidad y la calibración pedagógica se ajustan durante la implementación; no son bloqueos nuevos para comenzar.

## Defaults permitidos y pendientes

Se pueden adoptar inicialmente los siguientes defaults sin convertirlos en decisiones rígidas: un objeto por apoyo; límites como no-op; distractores con no-op determinista; períodos de dos o tres turnos con desfase cero; una configuración inicial limitada, por ejemplo con solo `Avanzar`; y un límite de turnos configurable. La orientación inicial y su frase exacta se fijan en [agente.md](agente.md). Quedan pendientes la cantidad de distractores, los mapas, los pesos y los valores de puntaje.

## Verificación de comportamiento

La verificación debe cubrir el comportamiento, no depender solo de que se dibuje el recorrido:

- probar la matriz de colisiones en ambas direcciones y en turnos representativos de cada fase periódica, incluido el turno 0;
- comprobar que toda acción, no-op y acción fatal cuenta un turno en el orden correcto;
- comprobar que una fase nueva no hace caer a un robot que ya está en un apoyo seguro;
- verificar recogida única desde el apoyo actual, persistencia del inventario y habilitación de la llave;
- verificar victoria, derrota, límite, cancelación y error sin ejecutar una acción posterior;
- comprobar que el recorrido principal y el de transferencia tienen solución compatible con información local, objetos y límite elegidos;
- reproducir los casos de no-op y de colisión como las causas registradas.

Las pruebas pueden usar un adaptador de agente de prueba o un controlador de referencia para el motor. Eso sirve para validar reglas y resolución y no reemplaza la inferencia real requerida por la experiencia.

## Documentos relacionados

La experiencia visible se describe en [experiencia.md](experiencia.md); el ciclo y registro de intentos, en [intentos.md](intentos.md); las métricas y el puntaje, en [consumo-y-puntaje.md](consumo-y-puntaje.md); y las decisiones de plataforma, en [plataforma.md](plataforma.md).
