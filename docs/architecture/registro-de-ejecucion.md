# Registro de ejecución para reproducción

**Diseño aprobado. Implementación pendiente.** Concreta los requisitos acordados de [intentos](../intent/intentos.md), sin cambiar las [reglas del juego](../intent/juego.md). El reproductor y el catálogo de sprites se definen en [animación](animacion.md); la persistencia física aprobada se define en [datos](datos.md).

## Separación de responsabilidades

El motor determina qué ocurrió. El registro conserva esa resolución y sus estados. El reproductor decide cómo dibujarla. Posición y acción no bastan: caminar desde el mismo apoyo puede terminar en desplazamiento, caída o choque; recoger puede habilitar la salida; esperar puede cambiar una barrera sin mover al robot.

El registro completo contiene también observaciones, prompts, herramientas, respuestas, validaciones, reintentos y consumo. Esos datos siguen siendo obligatorios para auditoría, pero no hace falta descargarlos para animar. La API entrega una **vista de reproducción del mismo registro**, sin crear otra simulación ni otro historial autoritativo. La consulta exige el mismo propietario que la del intento.

## Datos que necesita el reproductor

| Dato | Contenido y propósito |
|---|---|
| Identidad y versiones | Intento, versión del formato, nivel y reglas. Permiten interpretar registros retenidos. |
| Escenario fijo | Tramos ordenados y sus tipos, apoyos, objetos con identidad/tipo/ubicación y salida. Referencia inmutable al nivel utilizado, nunca al nivel actual. |
| Estado inicial | Posición lógica, fases efectivas, objetos, inventario, salida, contadores y estado de juego antes de cualquier acción. |
| Acciones ordenadas | Acción interna normalizada, dirección/parámetros, estados anterior y posterior, resultado y causa. |
| Interacción | Tramo cruzado y apoyo objetivo, o identidad del objeto recogido. El objetivo de movimiento puede no haberse alcanzado. |
| Cierre | Número de acciones publicadas, referencia al último estado, resultado terminal y causa, incluidos cancelación y error. |

Los índices de apoyos, el mapa completo y las causas internas son para motor, registro y UI. **No se agregan al contexto del agente.** Se conserva la observación local permitida y la separación entre herramienta opaca e identidad semántica interna.

## Snapshots completos, guardados una sola vez

Se guarda el estado inicial y un snapshot dinámico completo después de cada acción. El estado anterior es el inicial o el posterior de la acción anterior; se referencia sin duplicarlo físicamente. La definición estática del nivel tampoco se copia en cada turno.

El snapshot contiene todos los datos dinámicos del motor. Para la reproducción se proyectan estos campos:

```ts
type ReplayState = {
  id: string;
  support: number;              // Último apoyo lógico; no posición del sprite.
  turnsUsed: number;            // Acciones ejecutadas, incluso la fatal.
  phaseTurn: number;            // Turno cuya fase está representada.
  terrain: TerrainState[];      // Estado efectivo de TODOS los tramos, por orden.
  remainingObjects: string[];   // Identidades; ubicación/tipo en el nivel fijo.
  inventory: string[];
  exitEnabled: boolean;
  status: "running" | "victory" | "defeat" | "incomplete";
};
```

Los nombres expresan el contrato lógico aprobado; la librería de tipos todavía no está implementada. Los estados efectivos iniciales incluyen suelo, pozo, obstáculo superior, barrera baja y barrera alta. El tipo de tramo en el nivel distingue una plataforma periódica de un pozo permanente aunque ambos presenten `pit` en ese turno.

**Se materializan las fases efectivas en cada snapshot.** El motor las calcula; el navegador las lee. Así una versión nueva del motor o de la fórmula de periodicidad no cambia una reproducción anterior. El reproductor no necesita importar reglas ni aplicar el módulo del período.

Después de una acción que continúa, ambos contadores avanzan: `turnsUsed` cuenta la acción y `phaseTurn` identifica el nuevo estado. Si esa acción termina el juego, solo avanza `turnsUsed`; se conserva la fase evaluada. Por ejemplo, una caída en el turno 4 deja `turnsUsed: 5` y `phaseTurn: 4`.

Cancelación y error son estados de cierre del intento, no nuevas acciones ni derrotas. Pueden cerrar sobre un snapshot cuyo estado de juego siga siendo `running`. El cierre conserva su causa operativa y referencia ese mismo mundo, sin inventar movimiento, fase o turno adicional.

La alternativa de guardar estado inicial más deltas reduce bytes, pero exige reconstruir los estados para inspeccionar decisiones y mantener lógica de aplicación para cada campo nuevo. Para recorridos pequeños y un máximo de turnos configurado, se eligen snapshots: facilitan auditoría y reproducción fiel sin reconstruir el mundo. Esta elección no implica controles para navegar la animación. No se mantienen snapshots y deltas como dos autoridades paralelas. El crecimiento aproximado es proporcional a acciones × tamaño del mundo dinámico; los límites de contenido se comprueban al publicar niveles, según [datos](datos.md).

## Acción intentada y resultado resuelto

Cada acción publicada referencia una decisión auditada y sus estados anterior y posterior. La selección opaca y argumentos originales permanecen en la auditoría; la reproducción usa la acción normalizada, sin traducir descripciones humanas ni interpretar texto del LLM.

| Campo | Significado |
|---|---|
| `seq`, `decisionId` | Orden consecutivo de acciones y vínculo a la decisión. Los reintentos de inferencia no agregan acciones. |
| `beforeStateId`, `afterStateId` | Estados exactos relacionados con esta acción. |
| `action` | Tipo interno —caminar, saltar, agacharse y avanzar, esperar, recoger o distractor—, dirección si corresponde y parámetros normalizados. |
| `resolution.outcome` | `moved`, `picked_up`, `no_op`, `fall` o `collision`. |
| `resolution.reason` | Código estable de la causa, no explicación libre ni razonamiento supuesto del modelo. |
| `resolution.segment`, `targetSupport` | Tramo del movimiento y apoyo al que se intentó llegar; presentes solo cuando existen. El destino alcanzado está en el estado posterior. |
| `resolution.objectId` | Identidad del objeto recogido, cuando el resultado fue `picked_up`. |

Las resoluciones son variantes tipadas: una caída requiere tramo, objetivo y causa; una recogida requiere objeto; un no-op identifica su motivo. Esperar, intentar salir del mapa, recoger sin objeto y una habilidad sin efecto tienen causas distintas. No se emite un tramo inexistente para un intento de salir del nivel.

El resultado de la interacción y el resultado del juego son conceptos distintos. Una acción `moved` puede llegar a una salida bloqueada y continuar, o a una habilitada y ganar. `picked_up` puede ganar si habilita la salida desde ese apoyo. Un no-op puede terminar por límite. Los snapshots y el cierre contienen el resultado del juego; el reproductor no vuelve a aplicar su precedencia.

**No se guardan píxeles, frames, velocidades ni un punto de colisión artificial.** El motor actual resuelve cruces discretos, no contactos físicos continuos. En las mecánicas actuales, acción, dirección, tramo, causa y estados permiten escoger una receta visual inequívoca. Sus anclas y curvas pertenecen al perfil visual. Si una mecánica futura admite resultados visualmente distintos que estos datos no distingan, se amplía el contrato con el dato semántico necesario en ese momento.

## Ejemplo de una caída

Fragmento ficticio de un registro, expandido para leer los estados sin seguir referencias. El nivel contiene un pozo en el tramo 1 y una barrera periódica en el tramo 2. No es una respuesta real del modelo ni un formato de almacenamiento adicional.

```json
{
  "seq": 4,
  "action": { "kind": "walk", "direction": "right" },
  "before": {
    "support": 1, "turnsUsed": 4, "phaseTurn": 4,
    "terrain": ["ground", "pit", "barrier_low"],
    "remainingObjects": ["key"], "inventory": [],
    "exitEnabled": false, "status": "running"
  },
  "resolution": {
    "outcome": "fall", "reason": "walk_into_pit",
    "segment": 1, "targetSupport": 2
  },
  "after": {
    "support": 1, "turnsUsed": 5, "phaseTurn": 4,
    "terrain": ["ground", "pit", "barrier_low"],
    "remainingObjects": ["key"], "inventory": [],
    "exitEnabled": false, "status": "defeat"
  }
}
```

La animación camina hasta el borde de entrada del pozo y cae. El robot no llega al apoyo 2 ni reaparece en el 1. Conservar el último apoyo lógico sirve para interpretar el mundo; no ordena dibujar allí la pose terminal.

Otros casos que el mismo contrato resuelve:

| Caso | Registro distintivo | Presentación |
|---|---|---|
| Saltar a la izquierda desde 2 hasta 1 | `jump/left`, tramo 1, `moved`, apoyo posterior 1 | Arco invertido; cruza exactamente un tramo. |
| Esperar ante barrera baja | `wait`, `no_op/wait`, mismo apoyo, siguiente fase alta | Robot quieto; la barrera cambia después de la espera. |
| Recoger llave en la salida | `picked_up`, ID de llave, salida habilitada y estado posterior victoria | Recoger, retirar llave, habilitar salida y celebrar, sin movimiento inventado. |
| Alcanzar salida sin llave | `moved`, salida bloqueada, estado posterior no victorioso | Llegar y permanecer; sin celebración. |
| Fallo técnico tras tres acciones | Tres acciones publicadas y cierre `error` sobre el último estado | Reproducir esas tres; informar error, sin caída ni cuarta acción. |

## Persistencia, lectura y consistencia

El ejecutor publica juntos la resolución, el nuevo snapshot y la secuencia de la cabecera mediante la transacción definida en [datos](datos.md). El estado anterior ya existe y es inmutable. No se confirma una acción sin estado posterior ni se vuelve a inferir por repetir su escritura.

El cierre fija el número de acciones y el último estado. La API puede entregar las acciones y sus estados posteriores juntos y paginados, conservando sus identidades; el primer bloque incluye el inicial y la referencia al nivel. El navegador completa y valida el registro **antes de empezar a animar**. Una página ausente o una referencia rota es un error de carga, no una secuencia más corta exitosa. Los cuerpos de inferencia se consultan aparte cuando se abre el diagnóstico.

Invariantes que verifican motor y registro: secuencia sin huecos; primer `before` igual al inicial; cada `before` igual al `after` anterior; una acción incrementa `turnsUsed` exactamente una vez; ningún evento después de un terminal; objetos únicos y salida coherentes; cierre sobre el último estado publicado. La implementación del reproductor valida estructura, referencias y compatibilidad para evitar una representación engañosa; no incorpora un segundo motor para revisar la física.

Se versiona el formato del registro y se mantienen referencias inmutables a nivel y reglas. Las consultas de reproducción utilizan los valores guardados aunque las reglas actuales ya sean otras. Cambios de formato necesitan lectores o adaptaciones explícitas que mantengan acciones, estados, causas y terminal; nunca recalcular el intento para migrarlo. La compatibilidad gráfica se define en [animación](animacion.md#compatibilidad-y-extensión).
