# Registro de ejecución para reproducción

**Registro y reproducción del nivel principal periódico.** El registro conserva snapshots, acciones, llamadas, uso y cierre del intento bajo `principal-periodico-v2`, versión 2 y `RULES_VERSION=2`. Concreta los requisitos de [intentos](../intent/intentos.md), sin cambiar las [reglas del juego](../intent/juego.md). El reproductor y su catálogo visual se describen en [animación](animacion.md); la persistencia física y sus claves se definen en [datos](datos.md).

## Separación de responsabilidades

El motor determina qué ocurrió. El registro conserva esa resolución y sus estados. El reproductor decide cómo dibujarla. Posición y acción no bastan: caminar desde el mismo apoyo puede terminar en desplazamiento, caída o choque; esperar puede cambiar el terreno periódico sin mover al robot.

El registro completo contiene observaciones, prompts, herramientas, respuestas, validaciones, llamadas y consumo junto con las acciones publicadas. Esos datos quedan en la autoridad de servidor y los bodies completos en S3 privado. La API entrega resumen, historial y estado; la vista de reproducción proyecta sólo nivel, estados, acciones y cierre necesarios para dibujar la secuencia. El diagnóstico detallado sigue pendiente. Toda consulta exige el mismo propietario que la del intento.

## Datos que necesita el reproductor

| Dato                  | Contenido y propósito                                                                                                                                                         |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identidad y versiones | Intento, versión del formato, nivel y reglas. Permiten interpretar registros retenidos.                                                                                       |
| Escenario fijo        | `principal-periodico-v2`, versión 2: siete tramos `ground`, `pit`, `ground`, `branch`, `barrier`, `platform`, `ground`; ocho apoyos y salida en el apoyo 7. |
| Estado inicial        | Posición lógica, fases efectivas, objetos, inventario, salida, contadores y estado de juego antes de cualquier acción.                                                        |
| Acciones ordenadas    | Acción interna normalizada, dirección/parámetros, estados anterior y posterior, resultado y causa.                                                                            |
| Interacción           | Tramo cruzado, apoyo objetivo y resultado `moved`, `fall`, `collision` o `no_op`; el objetivo puede no haberse alcanzado. Esperar conserva apoyo y puede cambiar la fase para el estado siguiente. |
| Cierre                | Número de acciones publicadas, referencia al último estado, resultado terminal y causa, incluidos cancelación y error.                                                        |

Los índices de apoyos, el mapa completo y las causas internas son para motor, registro y UI. **No se agregan al contexto del agente.** Se conserva la observación local permitida y la separación entre herramienta opaca e identidad semántica interna.

## Snapshots completos, guardados una sola vez

Se guarda el estado inicial y un snapshot dinámico completo después de cada acción. El estado anterior es el inicial o el posterior de la acción anterior; se referencia sin duplicarlo físicamente. La definición fija del nivel tampoco se copia en cada turno.

El snapshot contiene todos los datos dinámicos del motor. Para la reproducción se proyectan estos campos:

```ts
type ReplayState = {
  id: string;
  support: number; // Último apoyo lógico; no posición del sprite.
  turnsUsed: number; // Acciones ejecutadas, incluso la fatal.
  phaseTurn: number; // Turno cuya fase está representada.
  terrain: TerrainState[]; // Estado efectivo de TODOS los tramos, por orden.
  remainingObjects: string[]; // Vacío en el nivel vigente.
  inventory: string[]; // Vacío en el nivel vigente.
  exitEnabled: boolean; // Siempre true en el nivel vigente.
  status: 'running' | 'victory' | 'defeat' | 'incomplete';
  maxSupportReached: number; // Avance informativo del intento.
};
```

El snapshot materializa el terreno efectivo de los siete tramos. La barrera alterna entre `barrier_low` en turnos pares y `barrier_high` en impares; la plataforma es `ground` si el turno es múltiplo de tres y `pit` en los demás. El nivel no tiene objetos, por lo que las listas de objetos e inventario están vacías y la salida está habilitada desde el inicio. El `maxSupportReached` permite mostrar avance aunque el robot retroceda.

El snapshot inicial es `state-0`; cada acción publicada agrega una sola fila `STATE#<afterStateId>` y conserva el snapshot previo por referencia. `phaseTurn` avanza sólo si el juego continúa y queda congelado en el turno evaluado cuando hay fatalidad o victoria. El reproductor lee las fases efectivas guardadas sin recalcularlas.

Después de una acción que continúa, ambos contadores avanzan: `turnsUsed` cuenta la acción y `phaseTurn` identifica el nuevo estado. Si esa acción termina el juego, solo avanza `turnsUsed`; se conserva la fase evaluada. Por ejemplo, una caída en el turno 4 deja `turnsUsed: 5` y `phaseTurn: 4`.

Cancelación y error son estados de cierre del intento, no nuevas acciones ni derrotas. Pueden cerrar sobre un snapshot cuyo estado de juego siga siendo `running`. El cierre conserva su causa operativa y referencia ese mismo mundo, sin inventar movimiento, fase o turno adicional.

La alternativa de guardar estado inicial más deltas reduce bytes, pero exige reconstruir los estados para inspeccionar decisiones y mantener lógica de aplicación para cada campo nuevo. Para recorridos pequeños y un máximo de turnos configurado, se eligen snapshots: facilitan auditoría y reproducción fiel sin reconstruir el mundo. Esta elección no implica controles para navegar la animación. No se mantienen snapshots y deltas como dos autoridades paralelas. El crecimiento aproximado es proporcional a acciones × tamaño del mundo dinámico; los límites de contenido se comprueban al publicar niveles, según [datos](datos.md).

## Acción intentada y resultado resuelto

Cada acción publicada referencia una decisión auditada y sus estados anterior y posterior. La selección opaca y argumentos originales permanecen en la auditoría; la reproducción usa la acción normalizada, sin traducir descripciones humanas ni interpretar texto del LLM.

| Campo                                 | Significado                                                                                                                                                                      |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `seq`, `decisionId`                   | Orden consecutivo de acciones y vínculo a la decisión. Los reintentos de inferencia no agregan acciones.                                                                         |
| `beforeStateId`, `afterStateId`       | Estados exactos relacionados con esta acción.                                                                                                                                    |
| `action`                              | Tipo normalizado vigente (`advance`, `retreat`, `jump`, `crouch`, `swim` o `wait`), dirección si corresponde y parámetros validados. |
| `resolution.outcome`                  | `moved`, `no_op`, `fall` o `collision`. `picked_up` queda para la fase posterior de objetos. |
| `resolution.reason`                   | Código estable de la causa, no explicación libre ni razonamiento supuesto del modelo.                                                                                            |
| `resolution.segment`, `targetSupport` | Tramo del movimiento y apoyo al que se intentó llegar; presentes solo cuando existen. El destino alcanzado está en el estado posterior.                                          |
| `resolution.objectId`                 | Campo reservado para la fase posterior de objetos; no aparece en acciones vigentes.                                                                                              |

Las resoluciones son variantes tipadas: una caída o choque requiere tramo, objetivo y causa; un no-op identifica su motivo. Se distinguen límites izquierdo/derecho, Nadar sin efecto y Esperar. No se emite un tramo inexistente para un intento de salir del nivel.

El resultado de la interacción y el resultado del juego son conceptos distintos. Una acción `moved` puede llegar a una salida bloqueada y continuar, o a una habilitada y ganar. `picked_up` puede ganar si habilita la salida desde ese apoyo. Un no-op puede terminar por límite. Los snapshots y el cierre contienen el resultado del juego; el reproductor no vuelve a aplicar su precedencia.

**No se guardan píxeles, frames, velocidades ni un punto de colisión artificial.** El motor actual resuelve cruces discretos, no contactos físicos continuos. En las mecánicas actuales, acción, dirección, tramo, causa y estados permiten escoger una receta visual inequívoca. Sus anclas y curvas pertenecen al perfil visual. Si una mecánica futura admite resultados visualmente distintos que estos datos no distingan, se amplía el contrato con el dato semántico necesario en ese momento.

## Ejemplo de una caída

Fragmento ficticio de un registro del contrato vigente, expandido para leer los estados sin seguir referencias. No es una respuesta real del modelo ni un formato de almacenamiento adicional.

```json
{
  "seq": 2,
  "action": { "kind": "walk", "direction": "right" },
  "before": {
    "support": 1,
    "turnsUsed": 1,
    "phaseTurn": 1,
    "terrain": ["ground", "pit", "ground", "branch", "barrier_high", "pit", "ground"],
    "remainingObjects": [],
    "inventory": [],
    "exitEnabled": true,
    "status": "running"
  },
  "resolution": {
    "outcome": "fall",
    "reason": "walk_into_pit",
    "segment": 1,
    "targetSupport": 2
  },
  "after": {
    "support": 1,
    "turnsUsed": 2,
    "phaseTurn": 1,
    "terrain": ["ground", "pit", "ground", "branch", "barrier_high", "pit", "ground"],
    "remainingObjects": [],
    "inventory": [],
    "exitEnabled": true,
    "status": "defeat"
  }
}
```

La animación camina hasta el borde de entrada del pozo y cae. El robot no llega al apoyo 2 ni reaparece en el 1. Conservar el último apoyo lógico sirve para interpretar el mundo; no ordena dibujar allí la pose terminal.

Otros casos que el mismo contrato resuelve:

| Caso                                  | Registro distintivo                                                     | Presentación                                                                   |
| ------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Saltar a la izquierda desde 2 hasta 1 | `jump/left`, tramo 1, `moved`, apoyo posterior 1                        | Arco invertido; cruza exactamente un tramo.                                    |
| Esperar ante barrera baja             | `wait`, `no_op/wait`, mismo apoyo, siguiente fase alta                  | Robot quieto; la barrera cambia después de la espera.                          |
| Esperar antes de plataforma           | `wait`, `no_op/wait`, siguiente fase en el turno 3                      | Robot quieto; la plataforma cambia a suelo antes de la acción siguiente.      |
| Fallo técnico tras tres acciones      | Tres acciones publicadas y cierre `error` sobre el último estado        | Reproducir esas tres; informar error, sin caída ni cuarta acción.              |

## Persistencia, lectura y consistencia

El ejecutor publica juntos la resolución, el nuevo snapshot y la secuencia de la cabecera mediante la transacción definida en [datos](datos.md). El estado anterior ya existe y es inmutable. No se confirma una acción sin estado posterior ni se vuelve a inferir por repetir su escritura. La implementación actual conserva la acción en `ACTION#<seq>` y el snapshot en `STATE#<afterStateId>`; la cabecera sólo referencia el estado actual.

El cierre fija el número de acciones y el último estado. La vista de replay ensambla acciones y snapshots guardados, valida su secuencia y referencias y rechaza un registro incompleto o incompatible. No entrega bodies ni datos de diagnóstico. Una acción o snapshot faltante sigue siendo un defecto de registro, no una secuencia más corta exitosa.

Invariantes que verifican motor y registro: secuencia sin huecos; primer `before` igual al inicial; cada `before` igual al `after` anterior; una acción incrementa `turnsUsed` exactamente una vez; ningún evento después de un terminal; terreno efectivo correspondiente al `phaseTurn`; salida habilitada y sin objetos; cierre sobre el último estado publicado. La implementación del reproductor valida estructura y referencias para evitar una representación engañosa; no incorpora un segundo motor para revisar la física.

El registro fija el nivel y las reglas del contrato vigente. Un registro de formato, nivel o reglas retirados se rechaza; no se ejecuta de nuevo para reconstruirlo ni se mantienen lectores o adaptaciones anteriores. Los datos de prueba de contratos reemplazados pueden permanecer sin uso si no estorban, o eliminarse. La reproducción del contrato vigente se describe en [animación](animacion.md).
