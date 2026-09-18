# Enseñale a jugar al robot virtual

> **Antecedente de la propuesta; no es la especificación vigente.** La documentación actual está organizada por tema en el [README](README.md#documentación-del-producto) y en `docs/intent/`. Allí se incorporaron las decisiones posteriores sobre cuentas, cuota, persistencia, stack, AWS y prioridades. Este texto conserva la propuesta original, incluidas alternativas y decisiones abiertas que ya fueron resueltas. No es necesario consultarlo para implementar los requisitos actuales.

Propuesta y especificación funcional para implementar con Codex.

Contexto: AWS User Group AI Argentina, escenario del booth de AWS en Nerdearla, espacio aproximado de 30 minutos.

Este documento es autónomo: contiene las decisiones del diseño y no requiere consultar la conversación original. El nombre es provisional. Las tecnologías, el modelo y los valores numéricos de algunos parámetros todavía no se eligieron.

## 1. Propuesta corta para compartir con colegas

Proponemos un juego virtual para el booth de AWS en Nerdearla, protagonizado por un personaje de robot controlado por un agente de AI que debe superar un recorrido con obstáculos. Durante la sesión explicaremos cómo funciona y lo jugaremos de manera colaborativa: el público propondrá qué habilidades e instrucciones darle, y los presentadores aplicarán los cambios en pantalla. En cada intento veremos una animación de sus decisiones, con el desafío de llegar a la meta y mejorar el puntaje según los turnos utilizados, los tokens consumidos y los objetos recogidos. Así presentaremos el trabajo de AWS User Group AI Argentina y mostraremos de forma accesible cómo las herramientas, sus descripciones y las instrucciones influyen en un agente. Después de la sesión, los asistentes podrán jugar por su cuenta y seguir experimentando.

## 2. Encargo y criterio de interpretación

Implementar un videojuego educativo con un personaje de robot virtual controlado por un agente basado en un LLM. El usuario humano configura las capacidades y las instrucciones del agente; el agente intenta resolver un recorrido; el sistema calcula el resultado mediante reglas deterministas y después reproduce una animación de lo sucedido.

Todas las menciones a “robot” en este documento se refieren a ese personaje virtual. El recorrido, los objetos, los obstáculos y las acciones existen dentro de la simulación mostrada en pantalla; el alcance no incluye un robot físico ni hardware de robótica.

La experiencia debe servir para explicar el juego y jugarlo de manera colaborativa durante la sesión, y para que después cada participante pueda jugar por su cuenta. En la sesión, la colaboración consiste en proponer y decidir cambios sobre una partida compartida que operan los presentadores.

La implementación debe preservar el diseño funcional que sigue. No sustituir el agente real por un bot con decisiones programadas y no convertir la actividad en un juego manejado directamente por el humano.

Hay tres clases de información en este documento:

- **Decisión acordada:** forma parte del comportamiento solicitado.
- **Formalización:** expresa con precisión una decisión acordada, sin elegir tecnologías.
- **Propuesta de implementación o parámetro pendiente:** completa un detalle no fijado. Debe mantenerse fácil de cambiar y no presentarse como una decisión explícita del usuario.

Codex puede resolver detalles técnicos rutinarios con criterio propio y documentarlos. Si una elección altera la mecánica, la información disponible para el agente o el papel del público, debe conservar el comportamiento acordado y señalar la alternativa.

El usuario quiere elegir las tecnologías después de cerrar este diseño. Este documento no impone framework, lenguaje, motor gráfico, infraestructura, proveedor de inferencia ni modelo concreto.

## 3. Propósito, audiencia y experiencia

### 3.1. Contexto del evento

AWS invitó a los líderes de comunidades a ocupar aproximadamente 30 minutos del escenario de su booth en Nerdearla. La actividad debe presentar al user group y hacer participar al público.

AWS User Group AI Argentina busca conversaciones de un nivel intermedio o avanzado sobre AI: herramientas, agentes, evaluaciones, contexto, costos y decisiones de diseño. Esos ejemplos indican el nivel del grupo; no obligan a incluir GraphRAG, múltiples agentes u otras tecnologías en este juego.

El público puede ser junior y saber poco de AWS. La actividad debe entenderse observando el recorrido y las consecuencias de las decisiones. No se requieren conocimientos de AWS, programación o terminología de agentes para participar.

### 3.2. Dos formas de uso

- **En el booth:** los presentadores explican las reglas y cómo configurar al agente. Después juegan de manera colaborativa con el público: los asistentes proponen cambios, discuten las decisiones y observan juntos sus consecuencias; los presentadores escriben o aplican las sugerencias desde una única interfaz proyectada en pantalla.
- **Después de la sesión:** cada participante puede utilizar la misma experiencia por su cuenta para configurar al robot virtual, ejecutar intentos y seguir experimentando en su casa.

La forma de distribución posterior no está decidida: podría ser una aplicación accesible por web o un proyecto que se ejecute con configuración propia. No convertir registro de usuarios, votaciones por QR, ingreso desde muchos teléfonos o un ranking global en requisitos del núcleo.

### 3.3. Qué debe descubrir el participante

- Una herramienta habilitada le da al agente una capacidad real.
- La descripción de esa herramienta influye en cómo entiende cuándo utilizarla.
- Las instrucciones generales influyen en las decisiones.
- Una descripción incorrecta puede llevar a usar una acción en una situación equivocada.
- Disponer de muchas herramientas o instrucciones extensas aumenta el contenido enviado al modelo; el efecto sobre el desempeño debe observarse, no presumirse.
- El resultado puede evaluarse objetivamente: completó o no el recorrido, cuántos turnos utilizó, qué objetos recogió y cuántos tokens consumió.
- Una configuración útil debería funcionar también en otro recorrido con las mismas mecánicas.

El “aprendizaje” entre intentos consiste en editar la configuración del agente. No se entrenan pesos del modelo ni se implementa aprendizaje por refuerzo.

### 3.4. Relación con la otra propuesta

El kiosco de empanadas atendido por una IA quedó como una alternativa de actividad. No forma parte de este juego y no debe mezclarse con su implementación.

## 4. Resumen de decisiones firmes

1. Juego virtual de desplazamiento lateral, con un personaje de robot en pantalla y un recorrido representado lógicamente como una secuencia de tramos.
2. Cada tramo se atraviesa entre puntos de apoyo seguros.
3. Se elimina el salto largo del alcance acordado. Cada acción de movimiento atraviesa exactamente un tramo, hacia un lado.
4. El robot puede avanzar, retroceder, saltar, atravesar un tramo agachado, esperar y recoger un objeto.
5. Saltar y avanzar agachado admiten dirección izquierda o derecha.
6. No hay postura agachada persistente ni una acción separada para levantarse.
7. Hay un catálogo de capacidades implementadas de antemano, con habilidades útiles y otras que pueden resultar innecesarias, como nadar.
8. El humano habilita habilidades del catálogo y escribe sus descripciones. También edita las instrucciones generales.
9. El agente recibe identificadores opacos de herramientas, como “tool_1”, y las descripciones escritas por el humano.
10. Los nombres semánticos, como “Saltar”, se muestran en la interfaz humana. No se entregan al modelo como nombres de herramientas ni se filtran mediante metadatos auxiliares.
11. El agente recibe todas las herramientas habilitadas en ese intento. El motor no filtra la lista según cuáles funcionarían en el obstáculo actual.
12. En cada turno el agente debe elegir una única herramienta.
13. Cada decisión es independiente: sin historial, memoria de decisiones anteriores ni resultados previos en el contexto.
14. La observación es local: punto actual, tramo inmediato a la izquierda y tramo inmediato a la derecha, en su estado presente.
15. El número de turno existe en el motor, pero no se agrega a la observación del agente. Tampoco se entregan fórmulas de ciclos o estados futuros.
16. El estado periódico de los obstáculos se calcula a partir del turno.
17. Toda acción de juego consume un turno, aunque no cambie posición ni inventario.
18. El motor evalúa las acciones y determina los resultados programáticamente.
19. Una acción de movimiento incompatible con un obstáculo provoca una derrota.
20. Una acción sin efecto no provoca por sí misma una derrota; consume el turno.
21. Los objetos se recogen mediante una acción. Pueden habilitar la salida o tener un valor para el puntaje final.
22. Un intento se calcula completo hasta ganar, perder o alcanzar un límite de turnos. Después se reproduce la animación.
23. La reproducción no llama al LLM y no toma nuevas decisiones de juego.
24. Cada intento usa una versión fija de la configuración del agente y del nivel.
25. Al reiniciar se restaura el mundo inicial; se conservan las modificaciones del agente y se sigue sin memoria.
26. Ganar significa completar el recorrido y satisfacer las condiciones de su salida.
27. La puntuación final considera turnos, tokens y objetos especiales recogidos.
28. Solo los intentos completados se clasifican como soluciones en el ranking.
29. Los niveles deben poder resolverse con esa observación local y sin memoria.
30. El comportamiento inicial debe surgir de limitaciones y descripciones reales. No se programan derrotas artificiales del LLM ni se garantiza que una mala descripción siempre lo haga fallar.
31. Durante la sesión se explica la experiencia y se juega colaborativamente con el público, mientras los presentadores operan la interfaz.
32. Después de la sesión, los participantes pueden jugar por su cuenta con las mismas mecánicas.

## 5. Modelo lógico del recorrido

### 5.1. Tramos y puntos de apoyo

La notación original era:

~~~text
_ _ _ X _ _ _ T _ T _ X _ _ [FIN]
~~~

En esa notación, “_” representa un tramo libre, “X” un pozo y “T” una rama baja que requiere pasar agachado.

Para evitar ambigüedades al mover al robot, formalizar así:

- Hay N tramos ordenados, con índices de 0 a N−1.
- Hay N+1 puntos de apoyo, con índices de 0 a N.
- El robot comienza en el punto 0.
- La posición lógica del robot es un punto de apoyo, no el centro de un obstáculo.
- Desde el punto p, moverse a la derecha atraviesa el tramo p y llega al punto p+1.
- Desde el punto p, moverse a la izquierda atraviesa el tramo p−1 y llega al punto p−1.
- El punto N contiene la salida.
- Los objetos se ubican en puntos de apoyo.

Los índices son internos. No deben aparecer en la observación del agente como coordenadas, identificadores de casillas o datos que le permitan deducir el mapa completo.

### 5.2. Consecuencia visual y física

Saltar un pozo atraviesa el tramo correspondiente y termina en el apoyo seguro del otro lado. El robot nunca queda parado en el pozo.

Si un tramo era suelo durante una acción y se convierte en pozo en el turno siguiente, el robot ya está en un punto seguro. No cae automáticamente porque el tramo que cruzó cambió detrás de él.

Los obstáculos no ocupan ni destruyen los puntos de apoyo. Esta simplificación es intencional y forma parte de la mecánica acordada.

### 5.3. Límites

En el punto 0 no existe tramo a la izquierda. En el punto N no existe tramo a la derecha.

**Default propuesto:** intentar salir de esos límites tiene resultado “sin efecto” y consume un turno. La observación debe mostrar un límite de manera explícita.

No permitir índices negativos, saltos fuera del mapa ni interpretar que salir por cualquier extremo significa ganar.

## 6. Reloj y obstáculos periódicos

### 6.1. Turnos

Cada intento empieza en el turno 0. Todas las acciones de juego duran un turno, incluyendo esperar, recoger un objeto o ejecutar una habilidad sin efecto.

Para resolver una decisión:

1. Calcular el estado del mundo correspondiente al turno t.
2. Construir la observación local de ese estado.
3. Solicitar una herramienta al agente.
4. Validar la respuesta como una llamada a una herramienta habilitada.
5. Evaluar la acción usando exclusivamente el estado del turno t.
6. Registrar el resultado y contar un turno utilizado.
7. Si el intento continúa, pasar al turno t+1.

La barrera no cambia de altura durante la evaluación de una acción. En pantalla puede animarse su cambio entre una acción y la siguiente.

Si la acción es fatal, el turno se cuenta como utilizado, pero la reproducción termina con la colisión o caída de esa acción. No representar una nueva fase jugable después de la derrota.

### 6.2. Representación periódica

Usar datos deterministas para representar los ciclos. Una formalización posible:

~~~text
estado_del_tramo(i, t) = fases_i[(t + desfase_i) mod cantidad_de_fases_i]
~~~

El desfase por tramo es un detalle técnico opcional; por defecto puede ser cero. Los niveles iniciales pueden utilizar períodos de dos y tres turnos.

Ejemplos acordados:

| Tipo | Turno | Estado | Forma de atravesarlo |
|---|---|---|---|
| Obstáculo que sube y baja | Par | Barrera baja | Saltando |
| Obstáculo que sube y baja | Impar | Barrera alta | Agachado |
| Plataforma periódica | Múltiplo de 3 | Suelo | Caminando; también puede permitir salto o paso agachado |
| Plataforma periódica | Resto de turnos | Pozo | Saltando |

La animación del primer caso debe mostrar claramente que el obstáculo pasa de bloquear la zona baja a bloquear la zona alta. La del segundo caso debe distinguir suelo presente y pozo.

Con períodos dos y tres, el patrón de obstáculos se repite cada seis turnos. Los objetos recogidos y el inventario no se reinician por ese ciclo.

### 6.3. Estado periódico versus estado persistente

El terreno se deriva de nivel y turno. La presencia de objetos se deriva también de las recogidas realizadas. El estado de una salida con llave depende de la posesión de esa llave.

No definir el mundo entero como una función del turno que vuelva a crear objetos recogidos.

### 6.4. Esperar debe tener una consecuencia real

Esperar conserva posición e inventario, pero avanza el turno. Por lo tanto, puede cambiar qué movimiento conviene hacer después.

No prometer que esperar es siempre necesario con todas las habilidades habilitadas. Por ejemplo, si una plataforma alterna entre suelo y pozo y el agente sabe saltar, puede cruzarla saltando mientras es pozo. Esperar puede ser una alternativa para configuraciones sin salto.

Si se quiere un obstáculo completamente bloqueado en algunas fases para obligar a esperar, eso sería contenido adicional a definir. No inventar silenciosamente ese requisito ni cambiar las reglas del pozo para forzar una espera.

## 7. Acciones, efectos y compatibilidad

### 7.1. Acciones útiles acordadas

| Nombre en la interfaz | Desplazamiento | Parámetros funcionales | Efecto |
|---|---:|---|---|
| Avanzar | +1 apoyo | Ninguno | Atraviesa a pie el tramo de la derecha |
| Retroceder | −1 apoyo | Ninguno | Atraviesa a pie el tramo de la izquierda |
| Saltar | Un tramo | Dirección izquierda/derecha | Atraviesa el tramo por el aire |
| Agacharse y avanzar | Un tramo | Dirección izquierda/derecha | Atraviesa el tramo agachado |
| Esperar | 0 | Ninguno | Permanece en el apoyo y deja pasar un turno |
| Agarrar objeto | 0 | Según la cantidad de objetos por apoyo | Recoge un objeto disponible en el apoyo actual |

Saltar y pasar agachado hacia la izquierda deben estar implementados. Retroceder caminando no alcanza para volver a cruzar un pozo o una rama.

La postura agachada dura esa acción. El siguiente movimiento se evalúa según su propia modalidad. No agregar estados persistentes de postura ni una herramienta “levantarse”.

### 7.2. Catálogo y distractores

El catálogo de acciones del motor existe antes de la partida. “Agregar una habilidad” significa habilitar una entrada de ese catálogo para el agente.

Incluir la posibilidad de habilidades innecesarias para el nivel. “Nadar” fue el ejemplo concreto. En los recorridos base, sin agua, puede resolverse como una acción sin efecto que consume un turno.

La cantidad de distractores y sus nombres adicionales no están fijados. Deben ser fáciles de extender sin cambiar el núcleo. No es obligatorio construir un catálogo enorme para demostrar el costo de contexto.

Una habilidad distractora igualmente debe tener un efecto definido y determinista; puede ser un no-op. No ejecutar código generado por el usuario para implementar habilidades nuevas.

### 7.3. Matriz base de compatibilidad

La validez depende del estado actual del tramo y del modo de atravesarlo, no del texto de la descripción de la herramienta.

| Estado del tramo | Caminar | Saltar | Pasar agachado |
|---|---|---|---|
| Suelo libre | Válido | Válido | Válido |
| Pozo | Derrota por caída | Válido | Derrota por caída |
| Rama baja / obstáculo superior | Derrota por choque | Derrota por choque | Válido |
| Barrera baja | Derrota por choque | Válido | Derrota por choque |
| Barrera alta | Derrota por choque | Derrota por choque | Válido |

Saltar sobre suelo libre es válido, aunque pueda resultar innecesario. No imponer una única respuesta correcta cuando varias acciones funcionan.

Las modalidades de caminar a derecha e izquierda comparten reglas de colisión. Saltar y agacharse se evalúan de la misma forma en ambas direcciones.

### 7.4. Acciones sin efecto

Ejemplos:

- Esperar.
- Agarrar objeto cuando no hay ninguno.
- Nadar en un nivel sin agua.
- Intentar moverse fuera de los límites, bajo el default propuesto.

No cambian posición ni inventario, excepto las acciones cuya definición indique otro efecto. Consumen un turno, generan un evento para la reproducción y conservan los tokens reales de la llamada.

Una acción sin efecto y una acción incompatible con un obstáculo son cosas diferentes. Caminar hacia un pozo pierde; nadar en el apoyo seguro no mueve al robot y no lo hace caer.

### 7.5. El motor no acepta cambios de física mediante texto

Cambiar una descripción a “esta habilidad gana el juego” no debe conceder la victoria. Escribir “salta tres tramos” no cambia el alcance real del salto.

Las instrucciones y descripciones afectan únicamente a lo que decide el LLM. El catálogo, los parámetros permitidos y las reglas del motor determinan lo que realmente ocurre.

## 8. Objetos, inventario y salida

### 8.1. Recogida

Los objetos están en el apoyo actual y deben recogerse mediante una herramienta. Pasar por ese apoyo no implica recogerlos automáticamente.

Recoger un objeto consume un turno, permanece en el mismo apoyo y puede modificar la fase del próximo obstáculo.

Un objeto recogido deja de estar en el suelo y queda registrado en el inventario interno del intento. No se puede recoger dos veces ni obtener puntos repetidos por el mismo objeto.

**Default propuesto para simplificar:** un objeto como máximo por apoyo, de modo que “Agarrar objeto” no requiera parámetros. Si se admiten varios, definir una selección inequívoca o un parámetro de objeto visible. No permitir recoger objetos remotos.

### 8.2. Objetos con distintos usos

Puede haber:

- Objetos necesarios para habilitar la salida, como una llave.
- Objetos especiales cuyo valor solo interviene al calcular los puntos finales.
- Objetos que tengan ambos atributos, si el contenido del nivel lo define.

Todos usan el mismo mecanismo de recogida. Los valores y requisitos se expresan como datos del nivel.

No sumar una mecánica de consumo, equipamiento, combinación, lanzamiento o uso manual de objetos. No fue solicitada.

### 8.3. Llave y salida

La llave habilita automáticamente la salida. No hace falta una herramienta adicional para usarla.

Llegar a la salida sin una llave requerida no gana la partida y no provoca por sí solo una derrota. La salida aparece bloqueada y el agente puede actuar, incluido retroceder.

El estado visible de la salida debe reflejar si está habilitada, sin necesidad de enviar el inventario completo al modelo.

Una salida sin requisitos está habilitada desde el comienzo.

### 8.4. Objetos al final

La victoria se detecta cuando el robot llega a la salida y cumple sus condiciones, o cuando estando en la salida obtiene el requisito que faltaba.

Ubicar las recompensas opcionales antes del punto donde se activa automáticamente la victoria. No colocar como recompensa ordinaria un objeto que solo podría recogerse después de que la partida ya terminó.

Al calcular el puntaje, usar los identificadores y valores de los objetos realmente recogidos en ese intento, no los objetos vistos ni los presentes en el nivel.

## 9. Agente sin memoria y observación local

### 9.1. Contenido de cada decisión

Cada invocación recibe:

1. Un protocolo mínimo para pedir una única llamada a herramienta.
2. Las instrucciones generales de la versión actual, escritas por el usuario.
3. Todas las herramientas habilitadas para esa versión, con sus identificadores opacos, esquemas fijos y descripciones escritas por el usuario.
4. Una observación local nueva del estado presente.

No recibe la conversación de decisiones anteriores. No recibe la herramienta elegida antes, el resultado anterior ni una síntesis de su historia.

Esto sigue siendo así dentro de un mismo intento. No confundir “sin memoria entre partidas” con la decisión más estricta tomada aquí: **sin memoria entre turnos**.

### 9.2. Observación exacta

| Parte | Contenido permitido |
|---|---|
| Actual | Objetos disponibles en el apoyo actual y estado de salida si corresponde |
| Izquierda | Estado presente del tramo inmediato a la izquierda, o límite |
| Derecha | Estado presente del tramo inmediato a la derecha, o límite |

No incluir por defecto:

- Mapa completo o tramos a mayor distancia.
- Coordenada global, índice de apoyo o identificadores de casillas.
- Turno actual, número de decisiones previas o turnos restantes.
- Fórmula, período, desfase o próxima fase de los obstáculos.
- Lista de movimientos válidos.
- Inventario completo.
- Puntaje acumulado, métricas de consumo o lista de objetos ya recogidos.
- Orientación o intención de movimiento recordada de un turno anterior.
- Resultados de intentos anteriores o descripciones corregidas automáticamente.

La versión de configuración puede guardarse internamente, pero no hace falta enviarla al modelo.

### 9.3. Ejemplo conceptual

~~~json
{
  "actual": {
    "objetos": ["llave"],
    "salida": "no_presente"
  },
  "izquierda": {
    "estado": "suelo"
  },
  "derecha": {
    "estado": "barrera_alta"
  }
}
~~~

Los nombres exactos de los campos son una decisión de implementación. El contenido debe respetar el límite de información acordado.

Los estados pueden describirse con términos comprensibles, como “pozo” o “rama baja”. El objetivo es que el usuario enseñe a utilizar las herramientas, no ocultar artificialmente toda la semántica del entorno.

No enviar estados como “requiere tool_3” o “saltar es la respuesta correcta”.

### 9.4. Restricciones para los niveles

El nivel debe poder resolverse mediante una política basada en esta observación local y en las herramientas e instrucciones configuradas.

Si en dos situaciones indistinguibles se necesitan decisiones opuestas por razones que no están en la observación, no se puede exigir al agente que las distinga.

Ejemplo que se debe evitar como requisito central: recorrer un corredor vacío hacia la derecha y después tener que regresar muchos apoyos por ese mismo corredor sin que el agente conozca una intención de vuelta, un destino, un inventario o un historial.

El retroceso puede ser útil cuando la razón está localmente disponible. Por ejemplo, una salida bloqueada y una llave en el apoyo inmediatamente anterior permiten un caso de retorno corto.

Verificar que exista una solución física no alcanza: también hay que comprobar que la información permitida sea suficiente para elegirla.

No resolver un nivel mal diseñado agregando memoria o ampliando silenciosamente la observación del agente.

### 9.5. Caché no equivale a memoria

El proveedor puede reutilizar técnicamente prefijos de prompt. Eso no habilita a enviar historial ni a conservar una conversación del agente.

La condición funcional es que cada decisión contenga únicamente las instrucciones, herramientas y observación autorizadas. El tratamiento técnico de la caché y su facturación se adapta al proveedor elegido.

## 10. Herramientas opacas y configuración editable

### 10.1. Dos identidades de cada herramienta

Separar:

- Identidad semántica interna, que determina la acción real.
- Nombre para humanos, como “Saltar”.
- Identificador enviado al modelo, como “tool_3”.
- Descripción editable escrita por el usuario.
- Esquema de parámetros, fijado por la implementación.

No filtrar la identidad semántica al modelo mediante el nombre de la función, un título auxiliar, una descripción automática o un esquema que explícitamente explique la solución.

El esquema puede comunicar la forma de un argumento, como la dirección izquierda/derecha. Las descripciones de parámetros deben limitarse al contrato del argumento y no suplir la explicación de qué hace la habilidad.

### 10.2. Asignación estable

**Default propuesto:** asignar identificadores opacos estables por habilidad durante toda la sesión. Habilitar o deshabilitar otras habilidades no cambia la relación entre un identificador y su efecto.

Una asignación ilustrativa:

| Interfaz humana | Identificador del agente |
|---|---|
| Avanzar | tool_1 |
| Retroceder | tool_2 |
| Saltar | tool_3 |
| Agacharse y avanzar | tool_4 |
| Esperar | tool_5 |
| Agarrar objeto | tool_6 |
| Nadar | tool_7 |

Los números concretos no son una decisión funcional; su opacidad y estabilidad sí deben preservarse.

### 10.3. Descripciones

Al agregar una habilidad desde la interfaz, el humano ve su nombre real, pero no recibe una descripción estratégica completa ya escrita para el modelo.

El usuario debe poder escribir y modificar la descripción. Puede ser útil, incompleta, ambigua o incorrecta.

Permitir una descripción vacía o ausente a nivel de producto. Si la API elegida no acepta una cadena vacía, el adaptador debe omitir el campo o utilizar la forma válida equivalente, sin insertar una explicación semántica automática.

No corregir los consejos equivocados ni completar una descripción con una solución experta detrás de escena.

Puede haber ayudas de interfaz sobre cómo editar un campo, pero no deben incorporarse automáticamente al prompt ni a la descripción enviada al modelo.

### 10.4. Instrucciones generales

El humano puede ver y editar el texto general del agente.

La separación entre instrucciones y descripciones es:

- La descripción explica lo que el usuario quiere que el agente entienda de una herramienta.
- Las instrucciones generales expresan objetivos, prioridades y reglas para decidir.

Ejemplos de contenido que el usuario podría escribir: “Si hay un objeto donde estás, recogelo”, “Ante un pozo, saltá”, “Si no podés avanzar, esperá”.

No precargar esos ejemplos como reglas ocultas. Las referencias a nombres humanos solo le serán útiles al agente si el texto de las herramientas permite asociarlos con un identificador opaco.

Un texto inicial mínimo propuesto sería: “Intentá llegar a la salida usando las habilidades disponibles”. El texto exacto y las capacidades inicialmente habilitadas son parámetros de la demostración, todavía no fijados.

### 10.5. Protocolo fijo del agente

Puede existir una instrucción técnica mínima no editable que exige:

- Elegir una única herramienta disponible.
- Respetar su esquema de parámetros.
- Tomar la decisión para la observación presente.

Ese protocolo no contiene soluciones, reglas de obstáculos, equivalencias entre identificadores y movimientos, ciclos del nivel ni una estrategia ganadora.

El prompt efectivo debe poder inspeccionarse en una vista de diagnóstico para que los presentadores comprueben que la configuración es honesta.

### 10.6. Activación de una versión

“Aplicar cambios” crea o guarda una nueva configuración. El intento siguiente toma una copia fija de ella.

No hace falta redesplegar infraestructura, reinstalar código ni crear un nuevo recurso de agente en la nube por cada edición.

Los cambios durante una reproducción, si la interfaz los permite, afectan solo al próximo intento. Nunca modificar retrospectivamente la configuración de uno ya calculado.

### 10.7. Sin traductor adicional

La versión acordada usa edición directa de habilidades, descripciones e instrucciones. No necesita un segundo LLM que interprete las sugerencias del público.

La idea anterior de un “profesor” que traduce lenguaje natural quedó sustituida por esa interfaz. No implementarla como componente obligatorio.

### 10.8. Configuración sin herramientas

**Default propuesto:** si no hay ninguna habilidad habilitada, la interfaz solicita agregar al menos una antes de iniciar una inferencia. No hacer una llamada que exige seleccionar una herramienta de una lista vacía.

No agregar una habilidad oculta para resolver ese caso. El usuario puede habilitar una habilidad aunque su descripción todavía esté vacía.

## 11. Ciclo completo de un intento

### 11.1. Flujo de la experiencia

1. El humano selecciona o revisa el nivel y la configuración del robot.
2. Habilita o deshabilita habilidades, escribe descripciones y edita las instrucciones.
3. Aplica la configuración.
4. Inicia un intento.
5. El sistema fija las versiones de nivel y configuración y reinicia el mundo.
6. Calcula las decisiones del agente en un loop hasta un resultado terminal.
7. Conserva el registro completo y las métricas.
8. Prepara los recursos necesarios para reproducirlo.
9. Reproduce la animación de ese intento.
10. Muestra el resultado, el consumo y el puntaje si corresponde.
11. Los presentadores preguntan al público qué cambiar, o el jugador individual edita por su cuenta.
12. Se inicia otro intento con la nueva configuración.

La simulación y la reproducción son fases distintas. El robot no espera una respuesta del modelo a mitad de un salto visible.

### 11.2. Loop del motor

Pseudocódigo conceptual, sin imponer lenguaje:

~~~text
configuracion = copia_fija(configuracion_aplicada)
nivel = copia_fija(nivel_seleccionado)
mundo = estado_inicial(nivel)
registro = []
uso = acumulador_vacio()

mientras el intento no sea terminal:
    si se alcanzó el límite de turnos:
        terminar como recorrido_incompleto

    estado_antes = copia(mundo)
    observacion = observar_localmente(nivel, mundo)

    respuesta = pedir_una_tool(
        protocolo_minimo,
        configuracion.instrucciones,
        configuracion.tools_habilitadas,
        observacion
    )
    contabilizar_uso_real(respuesta)

    llamada = validar_contrato_de_tool(respuesta, configuracion)
    si la respuesta no cumple el contrato:
        registrar y terminar como error_de_ejecucion

    resultado = resolver_accion(nivel, mundo, llamada)
    contar_un_turno_de_juego()

    si resultado es fatal:
        marcar derrota
    sino si se alcanzó una salida habilitada:
        marcar victoria
    sino si se alcanzó el límite de turnos:
        marcar recorrido_incompleto
    sino:
        avanzar_reloj_al_turno_siguiente()

    registrar_evento(
        estado_antes, observacion, llamada,
        resultado, copia(mundo), uso_de_esa_decision
    )

finalizar_registro_y_metricas()
preparar_reproduccion()
reproducir_registro()
mostrar_resultado()
~~~

La separación exacta entre el contador de turnos utilizados y el campo de turno del mundo puede variar. Debe preservar el orden de evaluación y contar también el turno fatal y los turnos sin efecto.

El evento conserva el turno evaluado en su estado anterior. Si la partida continúa, su estado posterior incluye el turno siguiente; el reproductor utiliza el anterior para dibujar la acción y pasa al posterior al terminar la animación. En una finalización no hay nueva fase jugable, aunque la última acción sí se cuente en los turnos utilizados.

Si se gana en el último turno permitido, la victoria tiene prioridad sobre el límite. Si se choca en ese turno, el resultado es derrota por el choque.

### 11.3. Una decisión, una acción

No pedir al modelo que resuelva el mapa completo ni que devuelva de una vez un array con el plan. El array o registro del intento se construye ejecutando el loop de decisiones individuales.

No permitir varias acciones de juego en una sola respuesta ni ejecutar una secuencia textual contenida dentro de una descripción.

No calcular las decisiones de diferentes turnos en paralelo: la observación siguiente depende de la acción y el estado resultante.

### 11.4. Reinicio

Cada nuevo intento restaura:

- Posición inicial.
- Turno 0.
- Objetos originales.
- Inventario vacío, salvo que un nivel futuro declare explícitamente otra condición.
- Estado inicial de la salida.
- Contadores de turnos y uso propios del intento.

Se utiliza la configuración actual del agente, con todas las modificaciones aplicadas por el usuario.

No importar resultados, memoria o conversaciones de intentos anteriores.

### 11.5. Estados terminales

| Estado | Causa | Se clasifica como solución |
|---|---|---|
| Victoria | Recorrido completado y salida habilitada | Sí |
| Derrota | Acción incompatible con un obstáculo | No |
| Recorrido incompleto | Límite de turnos alcanzado | No |
| Cancelado | El humano interrumpió el cálculo | No |
| Error de ejecución | Fallo de proveedor o respuesta que no cumple el contrato | No |

Los dos últimos son detalles operativos propuestos, necesarios para que una ejecución interrumpida no se presente como una derrota del robot.

Una respuesta que invoca una herramienta deshabilitada, inventa una herramienta, viola parámetros o devuelve varias acciones no debe ejecutarse. La política de reintento técnico debe definirse en el adaptador y ser acotada. No corregir silenciosamente una decisión semántica del agente.

Un reintento técnico no agrega una conversación con memoria ni ejecuta dos veces una misma acción. Conservar el uso reportado por las llamadas realizadas y distinguirlo de los turnos de juego.

## 12. Registro fiel y reproducción

### 12.1. Datos mínimos del intento

Guardar:

- Identificador del intento.
- Versión o copia de nivel y configuración.
- Modelo y parámetros de inferencia utilizados.
- Límite de turnos y parámetros de puntuación.
- Estado inicial.
- Eventos ordenados.
- Estado final y causa de finalización.
- Turnos utilizados, cantidad de llamadas, tokens y objetos recogidos.
- Puntaje, si se completó.

No depende de que estos datos se guarden en una base de datos específica. Deben permanecer disponibles al menos mientras se comparan y reproducen los intentos de la sesión.

### 12.2. Datos mínimos de un evento

- Número interno de decisión y turno evaluado.
- Estado anterior del mundo.
- Observación exacta enviada al modelo.
- Identificador de herramienta solicitado y argumentos.
- Identidad interna de la acción real, solo para motor, registro y UI humana.
- Resultado: movimiento válido, objeto recogido, sin efecto o derrota.
- Posición lógica de origen y destino, cuando corresponda.
- Objetos o estado de salida modificados.
- Motivo programático de la derrota o del no-op.
- Estado resultante.
- Uso de tokens y tiempo de inferencia de esa decisión, si el proveedor los informa.

El estado terminal de una caída puede requerir una posición visual intermedia distinta del apoyo lógico de origen. Guardar esa información como dato de animación o derivarla del evento; no animar al robot de vuelta a un apoyo después de caer.

### 12.3. Preparación previa

Antes de reproducir debe existir el registro completo del intento y deben estar listos los sprites y recursos gráficos necesarios.

No hace falta prerenderizar un archivo de video ni todos los frames. Un reproductor puede dibujar los frames normalmente a partir del registro cerrado, sin esperar inferencias o resultados nuevos.

Esto satisface el requisito de que la animación esté completamente determinada antes de comenzar.

### 12.4. Fidelidad

El reproductor:

- Ejecuta visualmente la secuencia registrada.
- No vuelve a llamar al modelo.
- No vuelve a decidir si el robot acertó.
- No altera el resultado para mejorar el espectáculo.
- No consume tokens nuevos.
- No utiliza una configuración editada después del intento.

Puede calcular el aspecto de los obstáculos a partir de la copia fija del nivel y el turno de cada evento. No debe recalcular la lógica de colisiones para producir un resultado diferente.

### 12.5. Animaciones necesarias

- Caminar a derecha e izquierda.
- Saltar un tramo en ambas direcciones.
- Atravesar un tramo agachado en ambas direcciones.
- Esperar.
- Recoger un objeto.
- Permanecer sin efecto para habilidades que no producen cambios.
- Caer por un pozo.
- Chocar con una rama o barrera.
- Llegar a la salida y ganar.
- Cambiar de fase los obstáculos periódicos.

El estilo sugerido es un side scroller con sprites, similar a juegos antiguos. La estética exacta, los assets y el motor gráfico no están fijados.

Durante la animación de una acción, mantener el estado de obstáculos que se utilizó para evaluarla. Animar el cambio de fase entre acciones, para que lo que el público ve coincida con las reglas.

### 12.6. Controles de reproducción

Como propuesta de implementación, incluir reproducir, pausar, repetir y velocidad de reproducción. La reproducción paso a paso es especialmente útil para explicar una caída o un cambio de fase.

Los controles no cambian acciones, turnos ni métricas. Repetir un intento ya calculado debe repetir exactamente el mismo resultado.

### 12.7. Espera durante el cálculo

La separación de fases elimina las demoras durante la animación, pero no el tiempo total de inferencia.

Mostrar un estado claro de “Preparando intento” durante el cálculo. Evitar bloquear la interfaz sin explicación. Los detalles de progreso pueden ser discretos para no revelar el desenlace antes de reproducirlo.

La duración real debe medirse al elegir modelo y tamaño del recorrido. No prometer una latencia específica sin medirla.

## 13. Interfaz de configuración y presentación

### 13.1. Vista principal

La pantalla debe permitir:

- Ver el recorrido y al robot.
- Identificar las habilidades habilitadas.
- Ver y editar la descripción de cada habilidad.
- Agregar o quitar habilidades del catálogo.
- Ver y editar las instrucciones generales.
- Aplicar cambios.
- Iniciar un intento.
- Reproducir uno ya calculado.
- Revisar el resultado y compararlo con intentos anteriores.

Priorizar legibilidad en una pantalla compartida de booth: texto legible, obstáculos reconocibles y resultado visible.

### 13.2. Lenguaje de la interfaz

Interfaz y descripciones educativas en español.

Usar etiquetas comprensibles para el público:

- Habilidades.
- Qué hace esta habilidad / descripción para el robot.
- Instrucciones del robot.
- Aplicar cambios.
- Probar recorrido.
- Ver intento.

Puede mostrarse la relación con términos técnicos, por ejemplo “Habilidades (tools)” e “Instrucciones (prompt)”. El propósito es hacer visibles esos conceptos de manera amigable.

No exigir editar JSON, código, schemas o infraestructura para participar.

### 13.3. Editor de habilidades

Cada habilidad debería mostrar:

- Nombre humano y, si ayuda, un icono.
- Estado habilitada/deshabilitada.
- Campo de descripción editable.
- Parámetros que admite, expresados de manera comprensible.
- Identificador opaco, disponible en la vista técnica o junto al nombre si ayuda a explicar el concepto.

La UI conoce el efecto real de la habilidad. La descripción que el usuario escribe es el texto que recibe el agente.

No confundir una ficha informativa de la interfaz con una descripción que se inyecte automáticamente al modelo.

### 13.4. Cambios y versiones

Debe ser claro si hay cambios todavía no aplicados. Al iniciar un intento, el sistema usa la configuración aplicada o aplica explícitamente el borrador como parte de esa acción.

Elegir una interacción consistente; no ejecutar inadvertidamente una versión distinta de la que el presentador cree estar mostrando.

Guardar una copia de configuración por intento. Poder volver a una configuración anterior es una mejora conveniente y simple; no se requiere un sistema complejo de versiones.

### 13.5. Resultado y explicación

Mostrar:

- Completó, perdió o no terminó.
- Obstáculo y acción que provocaron una derrota.
- Turnos utilizados.
- Objetos recogidos.
- Tokens consumidos.
- Puntaje para los intentos completados.
- Costo monetario estimado, si el adaptador dispone de datos suficientes.

Una explicación como “Intentó caminar por un pozo” debe derivarse de la regla aplicada por el motor. No inventar razonamientos internos del modelo ni mostrar una explicación generada después como si fuera la causa real de su decisión.

### 13.6. Vista de diagnóstico

Los presentadores o desarrolladores deberían poder inspeccionar:

- Observación de una decisión.
- Prompt efectivo, incluido el protocolo fijo.
- Herramientas y descripciones efectivamente enviadas.
- Herramienta elegida y argumentos.
- Resultado del motor.
- Uso de tokens.

Esta vista ayuda a comprobar que el contenido enviado es el correcto. No tiene que ocupar permanentemente la pantalla principal.

### 13.7. Público y juego individual

La versión para el booth permite explicar las reglas y jugar colaborativamente alrededor de una misma partida en pantalla. Los presentadores operan la interfaz escuchando las propuestas y facilitando las decisiones del público. No requiere que cada asistente tenga una cuenta, dispositivo o conexión.

Después de la sesión, cada participante puede jugar individualmente utilizando las mismas reglas y capacidades de edición. La infraestructura para compartirla después del evento se decide por separado.

## 14. Tokens, costo y puntuación

### 14.1. Medición real

Contabilizar el uso reportado por el proveedor en cada llamada. No estimar el consumo a partir de cantidad de caracteres ni asignar un costo ficticio fijo a cada herramienta.

La medición debe cubrir el contenido realmente enviado y generado: protocolo, instrucciones, definiciones de herramientas, observación y salida del modelo.

Las herramientas que no están habilitadas permanecen fuera de la solicitud al LLM y no suman contexto de inferencia.

### 14.2. Normalización de métricas

Guardar la respuesta de uso original y, cuando sea posible, normalizar:

- Tokens de entrada totales.
- Tokens de salida totales.
- Tokens de entrada leídos de caché.
- Tokens escritos en caché.
- Tokens de entrada sin caché.
- Tokens totales para la métrica de juego.

El adaptador debe consultar la documentación del proveedor elegido para evitar contar categorías dos veces. Algunas APIs incluyen caché en sus totales y otras la informan por separado.

La métrica de tokens del juego debe contar una vez cada token de entrada y salida reportado, incluyendo el contenido de entrada reutilizado mediante caché. Se distingue de su costo monetario.

Si una categoría de uso no está disponible, indicar esa limitación. No inventar valores ni presentar un costo parcial como consumo exacto.

### 14.3. Costo monetario

Si se muestra dinero, calcularlo con las tarifas correspondientes al proveedor, modelo, modalidad y categorías de tokens. Los tokens de entrada, salida y caché pueden tener tarifas diferentes.

Etiquetar ese dato como costo estimado de inferencia. No presentarlo como costo completo de infraestructura o factura definitiva.

Las tarifas y su fecha de referencia no están fijadas en este documento. Deben verificarse al implementar y mantenerse configurables.

### 14.4. Relación entre cantidad de tools y consumo

Agregar herramientas o alargar sus descripciones puede aumentar el contexto enviado en cada decisión. Sin embargo:

- Una herramienta útil puede permitir completar el recorrido.
- Una descripción mejor puede evitar acciones innecesarias.
- Una configuración con más contexto por llamada podría utilizar menos llamadas.
- La caché modifica el costo monetario.
- No se garantiza que un catálogo grande haga fallar al modelo.

Mostrar resultados medidos. No fabricar una penalización por cantidad de habilidades distinta de la que se haya definido explícitamente para el puntaje.

### 14.5. Fórmula acordada

Para intentos completados:

~~~text
puntos =
    base_por_completar
    + suma_del_valor_de_objetos_recogidos
    - penalizacion_por_turnos
    - penalizacion_por_tokens
~~~

Una formalización configurable:

~~~text
puntos =
    base
    + sum(valor_puntos(objeto) para cada objeto recogido)
    - peso_turno * turnos_utilizados
    - peso_tokens * (tokens_totales / unidad_tokens)
~~~

La unidad puede ser, por ejemplo, 1.000 tokens para que los coeficientes sean legibles. Los pesos, la base, los valores de objetos, el redondeo y la posibilidad de puntajes negativos siguen pendientes.

No hay valores numéricos aprobados. Codex puede proponer valores iniciales configurables después de observar consumos y duración, documentándolos como defaults.

El valor de los objetos debe permitir que recoger una recompensa pueda compensar el turno y los tokens adicionales. El sistema no debe favorecer sistemáticamente ignorar todos los objetos por una escala mal elegida.

### 14.6. Resultado de intentos incompletos

No incluir derrotas, límites de turnos, cancelaciones o errores en el ranking de soluciones completadas.

Mostrar su avance, turnos, objetos y consumo para que el usuario pueda comparar mejoras. Un intento que muere enseguida no se considera mejor por haber gastado menos.

**Default propuesto para avance:** mayor punto de apoyo alcanzado durante el intento dividido por el total de tramos. Mostrar también la posición de finalización si ayuda a entender un retroceso.

### 14.7. Comparaciones

Comparar principalmente intentos del mismo nivel y bajo los mismos pesos de puntuación. Registrar modelo y configuración de inferencia para contextualizar resultados.

No mezclar silenciosamente en una misma clasificación niveles diferentes o partidas con reglas de puntuación distintas.

Un ranking de la sesión o historial local alcanza para el núcleo. Un leaderboard público persistente no fue solicitado.

El resultado del LLM puede variar entre ejecuciones nuevas. La reproducción de un mismo registro es idéntica; volver a calcular con la misma configuración no promete las mismas decisiones.

## 15. Diseño de niveles y progresión de la actividad

### 15.1. Contenido base

El motor debe soportar desde el comienzo las mecánicas acordadas: movimiento en ambos sentidos, salto de un tramo, paso agachado, espera, objetos, salida y obstáculos periódicos.

Eso no obliga a presentar todas las dificultades al mismo tiempo. Diseñar un recorrido principal con una progresión legible.

Componentes que deberían estar representados en el contenido de demostración:

- Suelo libre.
- Pozo.
- Rama o barrera alta.
- Barrera que alterna entre baja y alta.
- Plataforma que aparece según el turno.
- Al menos un objeto recogible.
- Una recompensa que intervenga en el puntaje.
- Un caso con llave y salida bloqueada, si el recorrido seleccionado usa esa mecánica.

La ubicación exacta y el largo del recorrido no se fijaron.

### 15.2. Configuración inicial

La configuración inicial debe tener una limitación real: habilidades necesarias deshabilitadas, descripciones incompletas o instrucciones insuficientes.

Un punto de partida propuesto es que solo tenga habilitado avanzar. El texto inicial exacto y si se entrega una descripción mínima o vacía deben probarse para que el arranque resulte claro.

No obligar al modelo a equivocarse cuando eligió una acción válida. Si reconoce una limitación, se queda sin progresar o elige una alternativa, el resultado es legítimo.

### 15.3. Desarrollo posible

Un guion orientativo:

1. Ejecutar la configuración inicial.
2. Ver el obstáculo que no pudo resolver.
3. Pedir al público una habilidad o cambio de descripción.
4. Aplicarlo y volver a ejecutar.
5. Introducir una situación donde esa instrucción sea insuficiente o una descripción incorrecta se haga visible.
6. Agregar recogida de objetos y explicar que también consume un turno.
7. Observar cómo cambian los obstáculos con las esperas y otras acciones.
8. Una vez completado el recorrido, intentar mejorar consumo y puntaje.
9. Probar la configuración en otro recorrido con las mismas mecánicas.

La secuencia concreta de fallos no puede estar garantizada de antemano. El presentador debe reaccionar al resultado real del agente.

### 15.4. Segundo recorrido

Incluir un segundo recorrido corto que reordene o combine las mismas mecánicas. Su propósito es comprobar si las instrucciones sirven para situaciones nuevas.

No convertirlo en un conjunto amplio de niveles, editor de mapas o generación procedural obligatoria.

### 15.5. Recorridos resolubles sin memoria

Revisar especialmente:

- Que cada nivel tenga una solución con las capacidades disponibles en el catálogo.
- Que esa solución pueda descubrirse con la observación local permitida.
- Que no exija recordar que “ahora estoy volviendo”.
- Que los objetos necesarios sean recogibles antes de necesitarlos.
- Que los ciclos no vuelvan imposible una transición por un error de orden de turnos.
- Que los apoyos permanezcan seguros entre fases.
- Que el límite de turnos permita una solución razonable.

Para validar reglas puede usarse un controlador de referencia basado en reglas o una búsqueda del espacio de estados. Eso sirve como herramienta de desarrollo y no debe sustituir al agente de la demostración.

Una búsqueda que vea el mapa completo solo demuestra que existe una ruta ganadora. La suficiencia de la observación local requiere una comprobación adicional.

### 15.6. Ejemplos mínimos para probar mecánicas

Estos son casos de prueba propuestos, no recorridos definitivos:

| Caso | Qué debería comprobar |
|---|---|
| Un pozo entre dos apoyos | Caminar pierde; saltar cruza |
| Una rama entre dos apoyos | Caminar o saltar pierde; pasar agachado cruza |
| Barrera baja/alta | La compatibilidad se evalúa con la fase del turno actual |
| Puente periódico sin salto habilitado | Esperar hasta que aparezca permite cruzar |
| Objeto antes de una barrera periódica | Recogerlo cambia la fase que se encuentra después |
| Salida bloqueada y llave en el apoyo anterior | Se puede construir un retorno local sin memoria |
| Habilidad nadar en suelo | Consume un turno, sin movimiento |
| Apoyos vacíos con ida y vuelta indistinguibles | Detectar y evitar una exigencia de memoria implícita |

### 15.7. Tiempo de escenario

El espacio total aproximado es de 30 minutos. Una distribución sugerida, no obligatoria, es:

- 3 minutos: comunidad, objetivo y explicación de las reglas del juego virtual.
- 18 minutos: intentos y modificaciones con el público.
- 6 minutos: mostrar cómo se conectan habilidades, descripciones, instrucciones y consumo.
- 3 minutos: preguntas e invitación a AI Argentina.

El tiempo de cálculo entre reproducciones se puede utilizar para conversar sobre el cambio aplicado. La longitud real del nivel debe ajustarse después de medir el proveedor elegido.

## 16. Componentes lógicos de la implementación

Estas separaciones son responsabilidades de software, no una exigencia de microservicios:

1. **Definición del nivel:** tramos, fases, apoyos, objetos y salida.
2. **Motor determinista:** reloj, movimiento, compatibilidad, recogidas y estados terminales.
3. **Constructor de observaciones:** única proyección del mundo que puede recibir el agente.
4. **Catálogo de acciones:** asociación entre herramientas opacas y efectos reales.
5. **Configuración del agente:** habilidades habilitadas, descripciones e instrucciones.
6. **Adaptador de inferencia:** construye una solicitud sin memoria, obtiene una llamada a tool y normaliza uso.
7. **Ejecutor de intentos:** coordina el loop, límites, registro y errores.
8. **Registro y métricas:** conserva snapshots, eventos, consumo y resultados.
9. **Reproductor:** transforma eventos en animación.
10. **Interfaz humana:** edición, aplicación de cambios, ejecución, reproducción y comparación.

La solución puede ser una aplicación pequeña. No se requiere un framework de agentes complejo, una base vectorial, múltiples agentes, un sistema de planificación externo o un servicio desplegado por habilidad.

## 17. Contratos de datos conceptuales

Los siguientes contratos describen información, no librerías ni sintaxis obligatoria.

### 17.1. Nivel

~~~text
LevelDefinition
    id / version
    segmentos[]
        fases[]
        desfase opcional
        datos visuales
    apoyos[]
        objeto opcional
        salida opcional
    requisitos de salida
    posicion inicial
    limite de turnos
~~~

Debe cumplirse que la cantidad de apoyos sea la cantidad de segmentos más uno.

### 17.2. Objeto

~~~text
ObjectDefinition
    id
    nombre o apariencia visible
    valor para el puntaje final
    requisito de salida que satisface, si corresponde
~~~

Su identidad permite impedir recogidas duplicadas. El mismo efecto de recogida aplica a una llave o a un objeto de puntos.

### 17.3. Estado del mundo

~~~text
WorldState
    posicion
    turno
    objetos restantes
    inventario interno
    estado del intento
    datos internos necesarios para salida y métricas
~~~

No se necesita guardar el estado de todos los obstáculos como una segunda fuente de verdad: puede derivarse de nivel y turno.

### 17.4. Configuración del agente

~~~text
AgentConfiguration
    version
    instrucciones generales
    herramientas habilitadas[]
        identificador opaco
        referencia interna de catalogo
        descripcion escrita por el usuario
    configuracion de inferencia elegida para la aplicacion
~~~

La referencia interna no se serializa hacia el modelo. Los schemas pertenecen al catálogo y no son código editable por el público.

### 17.5. Resultado de una acción

~~~text
ActionResult
    resultado: movimiento / recogida / sin_efecto / derrota
    estado resultante
    motivo
    datos de animacion
~~~

Esta es una respuesta del motor para el ejecutor, la UI y el registro. No se devuelve como historial al agente en el turno siguiente.

### 17.6. Límites de información

Construir el payload del modelo a partir de campos explícitamente permitidos. No enviar un objeto de mundo completo esperando que el prompt le diga al LLM qué campos ignorar.

El backend o la lógica del juego conoce el mapa, el turno y el inventario. El modelo recibe únicamente la proyección acordada.

## 18. Detalles operativos que Codex debe resolver

Los siguientes son defaults o decisiones técnicas pendientes, no cambios de mecánica:

| Detalle | Criterio |
|---|---|
| Stack, lenguaje y framework | Elegir después; priorizar la solución más simple que cumpla la experiencia |
| Motor gráfico y assets | Soportar las animaciones requeridas y precargar los recursos |
| Proveedor y modelo | Debe permitir seleccionar herramientas con parámetros; medir calidad, costo y duración |
| AWS | Es el contexto del booth; Amazon Bedrock fue una opción considerada, sin cerrar el stack |
| Parámetros de inferencia | Mantenerlos documentados y estables para comparar intentos |
| Límite de turnos | Configurable por nivel o sesión; suficientemente alto para resolver y suficientemente bajo para cortar bucles |
| Pesos de puntaje | Configurables; todavía no hay números aprobados |
| Puntajes de objetos | Datos del nivel; calibrar respecto del costo de recogerlos |
| Configuración inicial | Limitación real, sin derrota guionada |
| Contenido exacto de niveles | Recorrido principal y recorrido de transferencia, resolubles localmente |
| Cantidad de objetos por apoyo | Default propuesto: uno |
| Número de distractores | Flexible; no hace falta un catálogo enorme |
| Límites de mapa | Default propuesto: acción sin efecto que consume turno |
| Guardado del historial | Como mínimo durante la sesión; persistencia posterior a definir |
| Reintentos de API | Acotados, registrados y sin duplicar acciones |
| Desempates del ranking | Definir y mostrar una regla simple si hacen falta |
| Distribución para jugar en casa | Elegir entre hosting de la app y ejecución con configuración propia |

La ausencia de valores numéricos no bloquea un prototipo. Codex puede elegir defaults editables y documentarlos, dejando claro que no eran acuerdos previos.

### 18.1. Aspectos de una eventual publicación

Si la aplicación usa credenciales de un proveedor, mantenerlas fuera del frontend y de archivos públicos. El texto de las descripciones no puede acceder a secretos ni a herramientas externas: el catálogo ejecutable se limita a las acciones del juego.

Si se ofrece una instancia pública que paga inferencias, definir límites de uso y presupuesto antes de abrirla. No asumir consumo público ilimitado.

Si varias personas utilizan la aplicación, sus configuraciones, objetos, intentos y resultados deben estar separados. Esto no impone un sistema de cuentas: el mecanismo depende del despliegue elegido.

Autenticación, hosting, infraestructura y publicación son decisiones posteriores. No convertirlas en requisitos arbitrarios de la mecánica.

## 19. Criterios de aceptación funcionales

### 19.1. Motor y turnos

- El mismo estado de mundo y la misma acción producen el mismo resultado.
- Avanzar, retroceder, saltar y pasar agachado mueven exactamente un tramo en la dirección correspondiente.
- Saltar y pasar agachado funcionan también hacia la izquierda.
- No existe salto largo ni parámetro que cambie el alcance.
- Esperar, recoger y cualquier no-op consumen un turno.
- Todos los estados utilizados para resolver una acción corresponden a su turno de inicio.
- Un objeto recogido no reaparece al cambiar el turno.
- Un apoyo seguro no se vuelve peligroso por el cambio de fase de un tramo vecino.
- Las acciones válidas en suelo libre incluyen caminar, saltar y pasar agachado.
- Una colisión o caída termina el intento en ese punto.
- El límite de turnos corta esperas y retrocesos indefinidos.
- Ganar en el último turno permitido cuenta como victoria.

### 19.2. Objetos y salida

- Un objeto solo se recoge desde el apoyo actual.
- Pasar por un objeto no lo recoge.
- Recogerlo cambia inventario interno y presencia en el suelo, y consume un turno.
- Intentar recoger donde no hay nada es un no-op.
- El mismo objeto no puede puntuar dos veces.
- Una llave habilita la salida sin otra herramienta de uso.
- La salida bloqueada permite continuar el intento.
- Los objetos de puntos utilizan el mismo mecanismo de recogida que la llave.
- La victoria termina la simulación y la reproducción en el lugar correcto.

### 19.3. Agente e información

- Cada turno utiliza una solicitud nueva sin historial.
- El payload no incluye número de turno, coordenadas globales, mapa completo, inventario completo, resultados previos o ciclos futuros.
- La observación contiene solo actual, izquierda y derecha, con los datos permitidos.
- El agente recibe todas las tools habilitadas, sin filtrado por compatibilidad con el obstáculo.
- No recibe equivalencias ocultas entre “tool_3” y “Saltar”.
- No recibe una lista de movimientos válidos.
- Las descripciones y las instrucciones enviadas coinciden con la versión aplicada por el usuario.
- El protocolo fijo no contiene soluciones.
- Cambiar la descripción no cambia la física de la acción.
- Una tool deshabilitada no puede ejecutarse aunque el modelo intente nombrarla.
- La respuesta produce una sola acción por decisión.

### 19.4. Registro y reproducción

- El intento está calculado por completo antes de iniciar su reproducción.
- Se registran observaciones, llamadas, estados, resultados y consumo.
- Reproducir, pausar, cambiar velocidad o repetir no genera llamadas de inferencia.
- Repetir un intento conserva exactamente sus acciones y resultado.
- Editar la configuración después no modifica un registro anterior.
- El obstáculo dibujado durante una acción coincide con el estado usado por el motor.
- El cambio de fase se muestra entre acciones.
- Una caída o choque se anima como la causa registrada, sin reemplazarla por otro resultado.

### 19.5. Interfaz, métricas y demostración

- Se puede habilitar una habilidad del catálogo y escribir su descripción desde la UI.
- Se pueden editar las instrucciones y aplicar una nueva configuración.
- Las capacidades tienen nombres humanos en la UI e identificadores opacos en el payload.
- Las descripciones equivocadas permanecen tal como fueron escritas.
- Las métricas provienen del uso real del proveedor; repetir una animación no las incrementa.
- La fórmula de puntos es visible o consultable y utiliza turnos, tokens y objetos.
- Solo las victorias se clasifican como soluciones.
- Los intentos incompletos conservan sus métricas de diagnóstico.
- El recorrido principal y el segundo recorrido son resolubles con la información permitida.
- El sistema funciona tanto para un presentador como para un jugador individual.
- El robot y el entorno se representan en pantalla como un juego virtual, sin componentes físicos de robótica.
- La interfaz permite explicar y jugar la actividad de manera colaborativa durante la sesión y continuar individualmente después.

## 20. Verificación y pruebas sugeridas

Priorizar pruebas que protejan las decisiones centrales:

1. Casos de la matriz de compatibilidad en ambas direcciones.
2. Límites de ciclos en turnos pares, impares y múltiplos de tres, incluyendo el turno 0.
3. Cambio de fase causado por esperar, recoger o ejecutar un no-op.
4. Recogida única, llave y condición de salida.
5. Finalización por victoria, derrota y límite, especialmente en el último turno.
6. Verificación del payload para impedir memoria o filtraciones de información.
7. Separación entre identificador opaco, descripción y efecto real.
8. Reproducción de un registro sin acceso al proveedor.
9. Conservación de snapshots al editar configuraciones.
10. Cálculo de métricas y puntos con datos de uso conocidos.
11. Un recorrido completo con un adaptador de prueba y otro con el proveedor real elegido.

Un adaptador simulado es apropiado para probar reglas y reproducción. Debe identificarse como modo de desarrollo y no reemplazar la inferencia real en la demostración.

Durante la calibración, probar al menos:

- Configuración inicial limitada.
- Configuración suficiente con descripciones útiles.
- Una descripción ambigua.
- Una descripción incorrecta.
- Una herramienta distractora adicional.
- Una descripción innecesariamente larga.
- La misma configuración en el segundo recorrido.

Evaluar resultados reales y tiempo de preparación. No exigir que una prueba de LLM siempre falle por una frase incorrecta ni confundir variación del modelo con un error determinista del motor.

## 21. Fuera del alcance acordado

No implementar como requisito:

- El kiosco de empanadas.
- Salto largo, saltos que atraviesen varios tramos o física libre.
- Juego en tiempo real mientras el LLM decide.
- Inferencias por frame.
- Control directo del robot por el público durante un intento del agente.
- Agente con historial o memoria.
- Observación del mapa completo.
- Un profesor LLM que traduzca instrucciones del público.
- Generación de código de habilidades en vivo.
- Entrenamiento, fine-tuning o aprendizaje por refuerzo.
- GraphRAG, bases vectoriales o múltiples agentes por el solo hecho de ser temas del user group.
- Postura agachada persistente y herramienta para levantarse.
- Uso manual, combinación o consumo de objetos.
- Un editor de niveles o generación procedural obligatoria.
- Votación distribuida, cuentas o ranking público obligatorio.
- Generación de un archivo de video por cada intento.
- Un redespliegue de infraestructura cada vez que cambia el prompt.

## 22. Entregables esperados cuando se implemente

Este documento no construye la aplicación; es el encargo funcional para el siguiente trabajo.

Al implementar, el resultado debería incluir:

- Aplicación funcional con edición, cálculo de intentos, reproducción y resultados.
- Catálogo de acciones y motor de juego separados de sus descripciones para el modelo.
- Recorrido principal y recorrido de transferencia.
- Configuración inicial y posibilidad de guardar o recuperar configuraciones de trabajo.
- Integración real con el proveedor elegido.
- Modo de prueba claramente identificado para desarrollar sin depender de inferencias.
- Instrucciones de instalación, configuración y ejecución acordes al stack.
- Documentación de las variables configurables: modelo, límite de turnos, pesos, niveles y tarifas si se muestran costos.
- Pruebas de las reglas y límites de información.
- Explicación breve de cualquier detalle técnico o default decidido durante la implementación.

No afirmar que la experiencia está lista para el booth únicamente porque la animación funciona. También deben estar verificados el circuito de edición, el uso real de herramientas, la independencia entre turnos, las métricas, la reproducción fiel y una duración de cálculo compatible con el espacio de presentación.
