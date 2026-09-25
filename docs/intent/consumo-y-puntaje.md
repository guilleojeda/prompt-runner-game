# Consumo y puntaje

Estado: consumo por llamada y puntaje de victorias implementados para `principal-puerta-v4`, con recompensa, llave, inventario y parámetros guardados. La llave abre la puerta y vale cero; la recompensa recogida vale 25 puntos. La clasificación entre soluciones y la calibración educativa siguen pendientes.

Esta página define qué uso se mide, cómo se diferencia el volumen de tokens del costo monetario y cómo se calcula y compara el puntaje. Se relaciona con [la experiencia](experiencia.md), [las reglas del juego](juego.md), [el agente](agente.md) y [la plataforma](plataforma.md). El ciclo y el registro de cada intento están en [intentos](intentos.md).

## Principios

El consumo se mide con los datos reales que informa el proveedor en cada llamada de inferencia. No se estima a partir de caracteres, longitud de textos ni una tarifa fija por herramienta. La reproducción de un intento ya calculado no realiza llamadas nuevas y, por tanto, no incrementa su uso.

Las métricas del contrato vigente se guardan junto al intento en el servidor, sin caducidad automática mientras ese contrato siga operativo, y quedan aisladas por usuario. Una configuración editada o una nueva ejecución nunca reescribe el consumo de un intento anterior. Los datos de prueba de contratos reemplazados pueden borrarse o quedar sin uso si no interfieren; no requieren lectores anteriores.

Las herramientas deshabilitadas no se incluyen en la solicitud al modelo y no suman contexto ni consumo. Las herramientas habilitadas se envían todas, aunque el obstáculo de ese turno haga que algunas no parezcan útiles.

El valor de `animation_enabled` pertenece a la presentación del intento. Guardarlo, reproducir automáticamente o reproducir manualmente no cambia el payload, la inferencia, los turnos, los tokens, el puntaje, la cuota ni las métricas. Las rutas con y sin animación conservan el mismo registro cerrado.

## Uso real por llamada

El adaptador conserva la respuesta de uso original del proveedor para cada llamada y, cuando la API lo permite, genera campos normalizados. El registro de un intento agrega las llamadas que efectivamente se hicieron, incluidos los reintentos técnicos acotados. Una llamada fallida puede no consumir tokens; si el proveedor informa uso, se conserva. Si no lo informa, se marca como desconocido y no se inventa un cero.

Los campos normalizados son:

| Campo | Significado |
| --- | --- |
| Entrada total | Tokens de entrada del contenido realmente enviado, con la semántica del proveedor resuelta por el adaptador |
| Salida total | Tokens generados realmente por el modelo |
| Razonamiento | Desglose incluido en salida, cuando la API lo informa; nunca se suma otra vez |
| Entrada sin caché | Parte de la entrada que no fue leída ni escrita mediante caché, si la API la distingue |
| Lectura de caché | Tokens de entrada servidos desde caché, si la API los informa |
| Escritura de caché | Tokens de entrada materializados en caché, si la API los informa |
| Tokens de juego | Volumen canónico de entrada y salida usado por la puntuación |
| Uso original | Campos y categorías entregados por el proveedor, sin perderlos durante la normalización |
| Tiempo de inferencia | Duración de la llamada o decisión, sólo si el proveedor o el adaptador la informa |

`Entrada total` es un agregado y, por definición, puede solaparse con sus componentes de caché. Si la API ya incluye la lectura o escritura de caché dentro de ese agregado, se conserva cada categoría como detalle, pero nunca se suma el agregado con sus componentes. Para derivar el total a partir de componentes separados, sólo se suman componentes que la documentación del proveedor confirma como partes disjuntas del contenido. El adaptador debe documentar la interpretación elegida para el proveedor activo.

`reasoningTokens` se conserva por llamada y en el intento. Si falta en alguna llamada, su agregado es desconocido; eso no impide calcular el puntaje cuando el total de entrada/salida sí es inequívoco. La UI lo identifica como incluido en salida. Cada intento conserva su modelo: agregar modelos no cambia la fórmula ni presupone equivalencia entre tokenizadores.

Si la API no permite determinar de forma inequívoca un total, se conserva el uso original y se indica que la métrica normalizada o el costo exacto no están disponibles. Un costo parcial no se presenta como consumo exacto.

## Tokens de la métrica de juego

La métrica de tokens del juego cuenta una sola vez cada token de entrada y salida efectivamente reportado, incluyendo el contenido de entrada reutilizado mediante caché:

```text
tokens_juego = entrada_total_canonica + salida_total
```

`entrada_total_canonica` se obtiene de la semántica de la API, no de sumar a ciegas un agregado con sus componentes. La lectura o escritura de caché puede afectar el costo, pero no crea una segunda copia de los tokens del contenido para esta métrica. Una configuración con más contexto por llamada puede gastar menos llamadas; la cantidad de tools por sí sola no recibe una penalización inventada.

Esta métrica representa volumen de inferencia para comparar soluciones y aplicar el peso de tokens. Es distinta del costo monetario: dos intentos con el mismo volumen de tokens pueden tener costos diferentes por modelo, modalidad o tarifas de entrada, salida y caché.

Los turnos y las llamadas son contadores diferentes. Un turno es una acción de juego ejecutada, incluso si fue esperar, recoger o no-op. Una llamada de proveedor y cada reintento cuentan para el uso y la cantidad de llamadas, pero una llamada inválida o fallida que no ejecutó una acción no cuenta como turno. Para un intento con resultado de error o cancelación se muestran las métricas acumuladas, aunque no tenga puntaje clasificable.

## Costo monetario estimado

Cuando se muestre dinero, se calcula por llamada y por categoría con las tarifas vigentes para proveedor, modelo, modalidad y fecha de referencia:

```text
costo_estimado = suma(costo_de_cada_categoria_de_cada_llamada)
```

Las tarifas de entrada, salida, lectura de caché y escritura de caché pueden ser distintas. La tabla de tarifas debe ser configurable y conservar la fecha o versión de referencia utilizada para el cálculo. No hay valores numéricos aprobados en esta especificación; se verifican y mantienen al implementar el adaptador.

La etiqueta debe decir «costo estimado de inferencia». No equivale a una factura definitiva ni al costo total de infraestructura, almacenamiento o tráfico. La caché puede bajar el costo monetario aun cuando sus tokens sigan incluidos una vez en `tokens_juego`.

## Fórmula de puntaje

Para un intento completado con victoria:

```text
puntos =
    base
    + suma(valor_del_objeto_recogido)
    - peso_turno * turnos_utilizados
    - peso_tokens * (tokens_juego / unidad_tokens)
```

La suma usa sólo los objetos realmente recogidos durante ese intento, una vez cada uno; no usa objetos vistos ni objetos que permanecieron en el nivel. `turnos_utilizados` incluye la acción final que produjo la victoria y todos los no-op, esperas y recogidas ejecutados. `tokens_juego` incluye el consumo de todas las llamadas realizadas para el intento, incluidos los reintentos técnicos que hayan informado uso.

El intento debe conservar la copia de los parámetros con los que se calculó: `base`, valores de objetos, `peso_turno`, `peso_tokens`, `unidad_tokens`, redondeo y política para puntajes negativos, si se define. Cambiar esos parámetros después no modifica retrospectivamente un puntaje ni vuelve comparables dos intentos que usaron reglas distintas.

Si el uso informado no permite determinar `tokens_juego` con exactitud, no se inventa un valor para producir un puntaje aparentemente preciso. Se conserva el intento y sus datos de uso, se muestra la limitación y el puntaje o su inclusión en una clasificación queda pendiente de contar con el total requerido.

Los valores vigentes se detallan abajo como defaults del contrato actual y se fijan en cada intento; no son una calibración pedagógica inmutable. No crear una penalización adicional por cantidad de habilidades.

El valor de un objeto debe calibrarse para que una recompensa pueda compensar los turnos y tokens adicionales que cuesta recogerla. La escala no debe favorecer sistemáticamente ignorar todos los objetos.

## Parámetros disponibles

El nivel principal vigente usa base 1000, peso de turno 10, peso de tokens 1 y unidad de tokens 1000. Redondea el resultado final a dos decimales y permite puntajes negativos. `recompensa-1`, fijada en el nivel del intento, aporta 25 puntos sólo si aparece en el inventario final; pasar por su apoyo no alcanza. `llave-1` abre la puerta, pero aporta cero puntos. Los valores efectivos se derivan de la copia del nivel, sin una segunda tabla mutable. Estos parámetros son defaults técnicos ajustables, no una calibración educativa acreditada.

La interfaz muestra turnos, llamadas, uso reportado, cantidad de objetos recogidos y aporte de la recompensa, con desconocidos explícitos. No ofrece ranking ni costo monetario por ahora. Sólo una victoria con el total de tokens conocido obtiene puntaje; ninguna falla técnica se presenta como derrota para asignarle puntos.

## Calibración inicial

La primera versión puede implementar la fórmula con parámetros configurables y mostrar los consumos reales antes de cerrar una calibración educativa. La calibración de cómo las descripciones influyen en el aprendizaje se realiza después de contar con algo funcionando; no es una condición para iniciar la construcción ni requiere imponer una secuencia garantizada de éxitos o fallos.

Hasta esa calibración:

- mostrar por separado turnos, llamadas, tokens de entrada y salida, categorías de caché cuando existan y objetos recogidos; el costo estimado sigue siendo opcional y, si se muestra, requiere datos de uso y tarifas suficientes para calcularlo;
- usar un `unidad_tokens` legible, como 1.000, y conservar el valor efectivo junto al intento;
- mantener base, pesos y valores de objetos configurables y consultables, y guardar la configuración efectiva junto al intento;
- explicar un resultado observado sin generalizarlo ni garantizar efectos futuros sin evidencia;
- conservar para diagnóstico el avance de los intentos que no llegan a la salida.

Para un intento incompleto, el default de avance es:

```text
avance = mayor_punto_de_apoyo_alcanzado / total_de_tramos
```

Se puede mostrar también la posición de finalización para explicar un retroceso. Este avance es informativo: no convierte una derrota, un límite, una cancelación o un error en una solución ni en una fila del ranking de victorias.

## Clasificación y comparabilidad

Sólo las victorias se clasifican como soluciones. Las derrotas, los límites de turnos, las cancelaciones y los errores conservan sus métricas y avance para diagnóstico, pero quedan fuera del ranking de soluciones completadas. Un intento que muere enseguida no es mejor por haber gastado menos.

La clasificación compara intentos del mismo nivel y con los mismos parámetros de puntuación. En la práctica, eso exige coincidir en la versión o copia del nivel y en la configuración efectiva de base, valores de objetos, pesos, unidad, redondeo y demás reglas que afecten los puntos. No se mezclan silenciosamente niveles ni reglas diferentes.

El historial propio o un ranking de la sesión alcanza para el núcleo. No se exige un leaderboard público persistente. Las comparaciones pueden mostrar modelo, configuración de inferencia y descripciones usadas para dar contexto, pero esas diferencias no se ocultan ni se tratan como equivalencia.

Si se necesitan desempates, todavía no hay una regla numérica aprobada. La implementación debe elegir una regla simple, hacerla visible y guardarla con los parámetros del ranking; esa elección no debe cambiar la clasificación básica de victoria ni mezclar reglas incompatibles.

## Variabilidad del LLM y exactitud del replay

Dos cálculos nuevos con la misma configuración pueden elegir acciones distintas por la variabilidad del modelo o del proveedor. Registrar modelo y parámetros permite contextualizar la comparación, pero no promete decisiones idénticas al repetir una inferencia.

La reproducción de un registro del contrato vigente conserva la misma secuencia de acciones y estados, las mismas causas, el mismo resultado, el mismo consumo y el mismo puntaje. La representación gráfica puede usar otros frames o recursos para ese contrato, manteniendo una velocidad fija y avance continuo sin controles del usuario. Iniciar otra visualización completa después del resultado no vuelve a inferir ni recalcula métricas. No se mantienen lectores para contratos reemplazados.

## Comprobaciones compactas

Como verificación focalizada:

- comparar un uso conocido con caché incluida y con caché informada por separado, comprobando que `tokens_juego` no suma dos veces el mismo contenido y, si se muestra costo monetario, que usa las categorías tarifarias correctas;
- si la política incluye reintentos técnicos, comprobar que conservan todas las llamadas y uso informado, pero no agregan turnos ni ejecutan dos veces una acción;
- calcular la fórmula con objetos recogidos, no recogidos, no-op, acción final y parámetros conocidos, y comprobar que editar parámetros no cambia un intento guardado;
- excluir de la clasificación cada estado que no sea victoria y separar intentos con nivel o pesos diferentes;
- ejecutar una nueva inferencia con la misma configuración para permitir variación, y reproducir el registro cerrado sin proveedor para comprobar identidad.
