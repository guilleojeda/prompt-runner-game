# Experiencia y alcance

Especificación vigente de la experiencia. El acceso, la preparación persistida y los intentos reales del nivel principal con recompensa, llave y puerta están implementados, con Esperar, Agarrar objeto, animación opcional, resultado directo, cancelación, historial, reproducción, inspección de decisiones, comparación de victorias propias y configuraciones de robot guardadas. Se relaciona con [intentos](intentos.md), [agente](agente.md), [reglas del juego](juego.md), [consumo y puntaje](consumo-y-puntaje.md) y [plataforma](plataforma.md).

## Propósito y participantes

El juego muestra cómo las habilidades disponibles, sus descripciones y las instrucciones generales influyen en un agente basado en un LLM. La persona configura al agente; el motor resuelve el recorrido con reglas deterministas; el reproductor presenta el registro cerrado. El personaje es un robot virtual y toda la actividad ocurre en pantalla.

Robot Runner: A puro prompt es un juego de Guille Ojeda con una beta pública gratuita. La primera versión prioriza completar el circuito funcional; no agrega como condición una duración máxima de cálculo, una tasa de éxito del modelo ni una secuencia educativa garantizada. Las condiciones de acceso y uso están en [plataforma](plataforma.md).

La interfaz está en español y debe poder entenderse sin conocer AWS ni programación. La duración del cálculo no es un criterio de rechazo ni una condición adicional de aceptación.

## Formas de uso

- **Sesión colaborativa:** los presentadores operan una única interfaz desde una computadora de escritorio conectada a un proyector. El público propone habilidades, descripciones e instrucciones y observa los resultados. Los asistentes no necesitan teléfono, cuenta ni conexión propia para participar verbalmente.
- **Juego individual:** cada participante entra a la aplicación web desde un navegador de escritorio, crea una cuenta con email verificado y usa las mismas mecánicas y posibilidades de edición. El registro, la cuota y el guardado se definen en [plataforma](plataforma.md).

La primera versión no requiere soporte para celulares o tablets. El booth y el juego individual usan las mismas reglas y el nivel principal vigente; sólo cambia quién opera la interfaz. La pantalla compartida debe mantener texto reconocible, obstáculos distinguibles y resultados visibles desde el proyector.

## Preparación disponible

La vista privada muestra las habilidades, sus descripciones e instrucciones y guarda automáticamente al dejar de escribir durante 600 ms. La persona puede seguir editando mientras se guarda una versión anterior; el aviso Guardado sólo corresponde al texto visible confirmado por el servidor. Hay estados de carga, cambios pendientes, guardado, error con reintento, límite de bytes y conflicto entre pestañas.

Antes del editor se muestra una vista estática del recorrido completo para el jugador, con casillas, obstáculos, recompensa, llave, puerta y salida. Los obstáculos periódicos se presentan en su fase inicial y se identifica que cambian con los turnos. Esta vista usa el mismo dibujo del reproductor, no simula una partida ni se envía al agente.

Las instrucciones generales admiten hasta 1.000 caracteres visibles y la descripción de cada habilidad hasta 500, también cuando está deshabilitada. Cada campo muestra su contador y máximo, incluyendo espacios y saltos de línea. Los caracteres visibles se cuentan como grafemas Unicode; pegar texto por encima del máximo conserva el contenido y bloquea guardado y Probar hasta corregirlo. El servidor valida los mismos máximos para nuevas escrituras y admisiones; las configuraciones históricas siguen consultables sin recortarse. Se conserva el límite conjunto de 65.536 bytes del borrador serializado, incluidos los contratos fijos: la pantalla avisa al alcanzar el 90% y rechaza el guardado si se supera, sin truncar textos. El contador permanente de bytes no aparece en la edición normal.

Un conflicto conserva el texto local y permite revisar la versión guardada antes de elegir cuál conservar. La resolución vuelve a comprobar la versión para no pisar una tercera edición. La renovación de la misma sesión pausa las escrituras y bloquea los controles del editor sin descartar cambios pendientes; otra identidad nunca hereda esos cambios. Al cerrar sesión con cambios sin confirmar se ofrece esperar/reintentar o descartar explícitamente los cambios locales pendientes. Pulsar **Probar** deja sin efecto una solicitud de salida anterior, incluidas las esperas de guardado que iban a cerrar la sesión. Una escritura ya enviada puede haber quedado guardada; salir no promete revertirla y no espera indefinidamente a la red. La cola local se detiene. La advertencia nativa al salir no garantiza guardar después de un cierre abrupto.

La pantalla está en español y se opera con teclado. Probar congela lo visible, confirma su guardado y admite un intento con control de versión. Se bloquean los controles, incluido cerrar sesión, hasta presentar el resultado; durante cálculo sólo Cancelar es operativo. Los errores de acceso o red permiten recuperar la sesión o consulta sin crear otro intento. El historial propio es paginado y abre resultados conservados. Si hay varios intentos activos desde otras sesiones, se elige cuál retomar antes de entrar en su cálculo; no se impone una exclusión global por usuario.

## Configuraciones de robot guardadas

El borrador activo es la edición que usa **Probar**. Cada cuenta puede guardar además varias copias nombradas del robot: modelo, habilidades, descripciones e instrucciones, sin nivel ni resultado. **Guardar como nueva** crea una copia desde el contenido visible confirmado; la lista privada permite abrirla de nuevo entre sesiones. **Cargar** coloca una copia en el editor mediante la conciliación de guardados pendientes. No inicia un intento.

Editar el borrador después de cargar una copia no la modifica. En la copia seleccionada, **Guardar** reemplaza explícitamente su nombre y contenido con control de versión; **Eliminar** requiere confirmación y borra sólo esa copia. Un conflicto o una respuesta de escritura incierta se comprueba antes de reintentar, sin sobrescribir cambios de otra pestaña. Las copias guardadas, el borrador y los snapshots de intentos tienen vidas independientes: eliminar una copia no cambia el borrador ni los intentos anteriores. Desde un intento propio terminal se puede recuperar su configuración al editor y luego guardarla como copia nueva, si cumple los máximos vigentes. La cantidad de copias nuevas está limitada por cuenta: al alcanzar el máximo, se puede consultar, editar y eliminar las existentes. El borrador activo y los snapshots de intentos no ocupan espacios de copias guardadas. Crear y eliminar actualizan la cantidad de forma atómica; editar no ocupa otro espacio.

Las operaciones de esta biblioteca no llaman al modelo ni consumen intentos de la cuota. Las escrituras y la carga se bloquean durante cálculo, animación automática, renovación de sesión y cambio de cuenta; las respuestas tardías no se aplican a otra identidad. La lista distingue las copias por ID estable aunque tengan el mismo nombre; también las diferencia visualmente y en el nombre accesible de su control de carga. Muestra estados de carga, error y conflicto recuperables.

No hay selector de nivel: se juega el único nivel vigente, `principal-puerta-v4`. La interfaz explica que una llave abre la puerta anterior a la salida libre; el resultado y el historial distinguen la llave recogida del valor de la recompensa. El toggle **Animación** está disponible y su preferencia se guarda en el servidor por usuario; cada intento conserva el valor elegido. Esperar y Agarrar objeto pueden habilitarse en el editor. Las referencias de recuperación de la pestaña no sustituyen el registro del servidor. Durante una admisión ya iniciada, la pestaña puede conservar transitoriamente la clave, versión, elección de Animación y snapshot exactos en `sessionStorage` para reintentar la misma solicitud tras una respuesta perdida. La referencia foreground conserva el intento cuyo cálculo o resultado todavía se debe recuperar y pasa al nuevo intento al admitirlo. No se conserva evidencia local de que una presentación ya se vio. El resultado se muestra al llegar al último frame o al elegir **Ver resultado** y el ACK se envía en segundo plano; si falla, el resultado sigue disponible y ofrece reintentar el ACK. Si se recarga mientras el servidor aún informa `presentationComplete=false`, la reproducción vuelve a empezar. Estas referencias no guardan un borrador alternativo ni funcionan como preferencia.

## Compartir un resultado

Desde el resultado actual o uno abierto del historial, **Compartir resultado** prepara una tarjeta PNG en el navegador. Una victoria muestra el puntaje persistido con dos decimales, turnos y si recogió la recompensa; si no hay puntaje conocido, muestra que llegó a la salida y conserva el valor como desconocido. Las derrotas e intentos incompletos muestran el avance máximo guardado, sin puntaje. Los intentos pendientes, en cálculo, cancelados o con error técnico no ofrecen esta acción.

La vista previa es la misma imagen que se descarga o adjunta. Se puede descargar la imagen, copiar el texto con el enlace a la presentación pública y, si el navegador admite compartir archivos, abrir el menú nativo. Cancelarlo no se informa como fallo. Ante una falla de generación se puede reintentar o copiar el texto; si el portapapeles no está disponible, el texto sigue seleccionable. El enlace abre la portada en `/` del origen desde donde se está jugando; no abre un intento público.

Compartir es voluntario. Sólo se incluyen resultado, turnos, recompensa o avance y la marca del juego. No se incluyen email, identidad, IDs, configuración, instrucciones, descripciones de habilidades ni registro de decisiones. No se llama al agente, no se consume cuota ni se almacena una copia en el servidor. No hay ranking público, URL por intento ni reproducción pública. La portada para enlaces del juego y de la presentación usa el mismo desafío y metadatos Open Graph y Twitter con una imagen PNG de 1200 x 630.

## Circuito de una partida

1. La persona accede a su cuenta y revisa el nivel principal y la configuración.
2. Edita el borrador: habilita capacidades del catálogo, escribe sus descripciones y modifica las instrucciones generales.
3. Ajusta el toggle **Animación**. Está activado por defecto, es ajustable y el servidor conserva esa preferencia para futuros intentos; el valor vigente se captura de nuevo en cada clic en **Probar**.
4. Hace clic en **Probar**. Los controles se bloquean inmediatamente mientras se valida la admisión y se guarda el borrador visible. El intento fija nivel, configuración, parámetros de puntuación y el valor actual de **Animación**. No hay un botón separado para aplicar el borrador.
5. Si el servidor admite el intento, inicia el cálculo secuencial y conserva el registro. La interfaz desplaza la vista al estado del intento, muestra «Preparando intento» y bloquea la edición. Al preparar la reproducción, vuelve a encuadrar la animación. Los textos para el jugador llaman casillas a las posiciones del robot.
6. Cuando el registro queda cerrado, si el snapshot tiene `Animación` activado, la interfaz reproduce automáticamente el registro completo. Al terminar muestra el resultado; si está desactivado, salta la reproducción y muestra el resultado de inmediato.
7. La persona consulta el resultado y el historial. Desde cualquiera de ellos puede inspeccionar decisiones en el mapa estático, iniciar otra reproducción completa o revisar la configuración fijada en ese intento. El historial ordena las victorias propias cargadas por puntaje y mantiene aparte los demás resultados. Puede cargar una configuración anterior en el editor, modificarla y volver a hacer clic en **Probar** para iniciar otro intento.

El snapshot de **Animación** es sólo una decisión de presentación para ese intento. No cambia el prompt, las herramientas, las llamadas, los tokens, los turnos, el puntaje, la cuota ni el registro. Ambas rutas guardan siempre el registro completo, las métricas y los recursos necesarios para reproducirlo después desde el historial.

## Estados de la interfaz y controles

Los estados de la interfaz describen qué puede hacer la persona. No son una copia de los estados del job del servidor: el job puede haber terminado mientras la interfaz sigue reproduciendo la animación automática.

| Estado de interfaz                        | Controles habilitados                                     | Comportamiento                                                                                                                                           |
| ----------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Edición                                   | Campos, toggle, **Probar** e historial                    | Se modifica el borrador y se puede iniciar una admisión                                                                                                  |
| Guardando o admitiendo                    | Ningún control operativo mientras se confirma la admisión | Si hay conflicto o error antes de admitir, se conserva el borrador, no se usa cuota ni agente y se vuelve a Edición                                      |
| Cálculo                                   | Sólo **Cancelar**                                         | Se bloquean campos, habilidades, toggle, **Probar**, historial e inicio de otras visualizaciones                                                         |
| Animación automática                      | Ninguno                                                   | Avanza a velocidad fija, hacia adelante y sin interrupciones; campos, habilidades, toggle, **Probar** e historial siguen bloqueados hasta terminar       |
| Resultado                                 | Campos, toggle, **Probar**, historial e inspección        | Se consulta el resultado, se pueden inspeccionar decisiones y se puede iniciar otro intento                                                              |
| Visualización desde resultado o historial | Ninguno mientras se reproduce                             | Una vez iniciada, avanza automáticamente de principio a fin a la misma velocidad fija; no hay inferencia ni edición o navegación durante la reproducción |

Durante el cálculo **Cancelar** es el único control operativo. No se habilita edición parcial ni se permite cambiar el toggle o las instrucciones hasta que el intento llegue a un estado terminal. La animación se muestra completa, en orden y a una única velocidad fija. Durante ella no hay controles para pausar, retroceder, avanzar, saltar turnos, reiniciar ni modificar la velocidad. El bloqueo continúa hasta presentar el resultado.

Una cancelación o un error sin acciones ejecutadas no inicia una reproducción vacía: muestra el resultado y desbloquea la interfaz. El diagnóstico técnico queda disponible en los detalles del agente. Si existe un registro parcial cerrado con acciones, se aplican las reglas de reproducción de [intentos](intentos.md) según el valor de **Animación** guardado. Un error o cancelación nunca se presenta como derrota del robot.

## Recarga y recuperación

El estado del intento en curso y el valor de **Animación** fijado al hacer clic en **Probar** se conservan en el servidor. Si la página se recarga durante el cálculo, recupera el intento y vuelve al estado de cálculo con los controles bloqueados; no crea otra inferencia ni otra cuota. Si el job ya terminó y el snapshot tiene `Animación` activada con `presentationComplete=false`, recupera el registro cerrado y reinicia su reproducción desde el principio; mantiene bloqueadas la edición y la consulta del resultado hasta terminarla. La reproducción recuperada no llama al modelo. Si el servidor informa `presentationComplete=true`, abre el resultado directamente. La interfaz muestra el resultado sin esperar el ACK; si el POST falla, el resultado queda disponible y permite reintentar. Una recarga antes de que el servidor confirme el ACK consulta el resumen de nuevo y, si continúa en `false`, vuelve a reproducir desde el principio. Si B se admite mientras el ACK de A sigue pendiente, el foreground pasa a B; A queda disponible en el historial y se recupera según su resumen actual del servidor.

Los estados de resultado no se consultan ni permiten editar mientras una animación automática recuperada siga pendiente. Una vez terminal y terminada la presentación, el resultado queda disponible. Los replays manuales desde el historial se pueden iniciar después del resultado y nunca crean inferencias nuevas.

## Edición y diagnóstico

La vista principal reúne el recorrido y el robot, las habilidades, sus descripciones, las instrucciones generales, el toggle **Animación**, **Probar**, el historial y los resultados. No requiere editar JSON, código, schemas ni infraestructura.

La orientación inicial aparece como ayuda contextual separada de los campos editables. Presenta la
configuración inicial limitada como un desafío: sólo Avanzar viene habilitada y las descripciones
están vacías a propósito. También distingue el papel de las instrucciones generales
(objetivo y prioridades) del de cada descripción de habilidad (texto literal que recibe el agente).
También aclara que, en cada decisión, el agente recibe las instrucciones, las habilidades
habilitadas y una observación local nueva, sin mapa completo ni historial de turnos. La ayuda puede
incluir un ejemplo breve y físicamente correcto de descripción, sin proponer una configuración o
una ruta ganadora.

El mapa inicial ofrece reglas consultables sobre los tipos de obstáculo, el efecto determinista de
las acciones y la recogida de objetos. La misma ayuda explica que las observaciones son locales y
que las decisiones son independientes; no agrega orientación para analizar una observación,
habilidad elegida o resultado después de una partida. Durante cálculo o reproducción automática,
las ayudas consultables quedan bloqueadas junto con el resto de la interfaz; sólo **Cancelar** se
mantiene operativo durante el cálculo.

En la vista autenticada, la cabecera del juego usa un espaciado compacto y conserva el enlace, la
marca y la introducción. La cuenta se presenta en una franja compacta. El pie del editor reúne **Probar**, **Animación**, el
saldo de cuota y su próxima renovación. La cuota muestra el saldo sobre el límite y una fecha y
hora legibles. El único modelo operativo se muestra como metadato junto al título del editor, como
información fija y no como un selector.
La pantalla mantiene el orden del mapa, editor y controles, resultado, copias guardadas e historial.
Las fechas de intentos y copias usan formatos humanos; los tokens se explican brevemente como
unidades de texto y conservan el valor desconocido cuando el proveedor no lo informa.

Las acciones del resultado aparecen separadas; **Volver al editor** es la acción principal, seguida
por los accesos de reproducción, inspección y configuración.

Los errores indican una causa comprensible y una acción disponible, mientras **Detalles del agente**
conserva el diagnóstico técnico desplegable. Desde un resultado terminal, **Volver al editor** lleva
el foco al editor sin cargar otra configuración ni modificar el borrador visible. Los paneles de
configuración e inspección reciben el foco al abrirse y devuelven el foco al control que los abrió al
cerrarse.

Cada habilidad presenta su nombre humano, si está habilitada, su descripción y sus parámetros en términos comprensibles. El identificador opaco puede consultarse en el diagnóstico. La información explicativa para la persona no se convierte automáticamente en instrucciones del modelo; ese límite pertenece al [contrato del agente](agente.md). No se requiere un sistema complejo de control de versiones para las configuraciones.

El borrador se mantiene separado del snapshot de cada intento. Un clic en **Probar** guarda directamente el contenido vigente y lo fija para el intento admitido. Si la validación, el guardado o la detección de conflicto fallan antes de admitirlo, se conserva el borrador, se muestran el error y su causa, y la interfaz vuelve a estar disponible. No se consume cuota ni se llama al agente en ese caso.

Un intento propio terminal permite consultar el modelo, las habilidades habilitadas, sus descripciones literales y las instrucciones que se fijaron al admitirlo. Al abrir el panel, el foco pasa a su título; **Cerrar** devuelve el foco al control que lo abrió, y un fallo de lectura permite **Reintentar carga** desde el panel. La consulta y el cierre del panel no dependen de que el borrador del editor haya cargado. **Usar esta configuración** se habilita cuando ese borrador está disponible y lo reemplaza explícitamente mediante el guardado habitual con control de versión; un conflicto o error conserva el contenido anterior y pide resolverlo. La acción no cambia el intento original, no inicia inferencia ni consume cuota. **Probar** usa una clave nueva y la preferencia actual de Animación. La comparación muestra sólo las victorias con puntaje de las páginas del historial ya cargadas y señala cuando faltan páginas; las demás partidas siguen consultables fuera de esa clasificación.

Desde un resultado propio o su historial, **Inspeccionar decisiones** abre el mapa completo para la persona; el agente nunca recibió ese mapa. Las casillas con decisiones muestran su cantidad y filtran una lista ordenada; la secuencia cronológica completa sigue disponible. Cada decisión se asigna a la casilla donde el robot estaba antes de elegir, aunque se haya movido o fallado. Una inferencia sin acción se muestra sin inventar un turno. La ficha presenta **Observación** local realmente enviada, **Acciones disponibles** (herramientas elegibles con ID opaco, nombre humano y descripción literal enviada), **Acción elegida** con parámetros cuando corresponda y **Resultado** registrado. Disponible no significa que la acción funcione en esa casilla. La vista identifica el intento inspeccionado; abrir uno del historial no reemplaza el intento activo ni interrumpe su cierre de presentación. La vista no inventa motivos ni sugiere cambios «Para revisar». Los prompts y bodies completos y el uso por llamada permanecen privados; la inspección no llama al modelo ni consume cuota. El mapa y sus listas se operan con mouse o teclado después del resultado, sin controlar la animación automática ni el replay.

## Resultados

La vista principal del resultado muestra victoria, derrota, límite, cancelación o error, los turnos utilizados, la recompensa y la llave recogidas, y el puntaje cuando corresponde. El avance máximo se muestra en resultados sin victoria. No se presenta una explicación narrativa de la causa de una derrota: el jugador la interpreta al revisar la observación, la acción y la resolución registradas.

Desde una derrota, **Ir a la última acción** abre el inspector en la última decisión que ejecutó una acción. Si no hay acciones, se selecciona la última decisión registrada; un registro vacío conserva un estado vacío legible. En otros resultados sin victoria, **Ver último paso** facilita revisar el cierre. **Inspeccionar decisiones** sigue abriendo la secuencia desde el principio. Ambos accesos funcionan también desde el historial, llevan la ficha seleccionada a la vista una vez cargada y no consumen cuota ni llaman al agente. El desplazamiento respeta la preferencia de reducir movimiento; las selecciones manuales no vuelven a desplazar automáticamente la página.

**Detalles del agente** es un desplegable inicialmente cerrado con modelo, nivel, integridad del registro, llamadas y categorías de tokens, incluido el diagnóstico técnico pertinente. Los datos desconocidos no se sustituyen por cero. El desglose visible del puntaje de una victoria muestra base, aporte de objetos, descuento por turnos, descuento por tokens y total guardado, con las reglas descritas en [consumo y puntaje](consumo-y-puntaje.md). Si faltan tokens, el puntaje no se presenta como exacto y el desglose identifica el dato no disponible.

El historial conserva la cantidad recogida y su aporte en puntos; sólo muestra puntaje en victorias. Los textos de interfaz usan puntuación ordinaria como comas y dos puntos. No usan separadores U+00B7 o U+2014. El costo monetario es opcional cuando hay datos suficientes y se identifica como estimado según [consumo y puntaje](consumo-y-puntaje.md).

## Contenido educativo y alcance

La configuración inicial tiene una limitación real en capacidades, descripciones o instrucciones. La frase de preferir la derecha forma parte de las instrucciones iniciales y es editable según [agente](agente.md). El catálogo y la física del nivel principal están en [juego](juego.md).

La experiencia puede mostrar resultados auténticos de una ejecución, incluyendo una derrota causada por una acción registrada. No garantiza que una descripción incorrecta produzca siempre una derrota, que agregar herramientas perjudique al modelo o que una descripción larga sea peor. La calibración educativa se realiza después de contar con una versión funcionando.

La estética, los assets, la distribución visual y el nombre final se pueden ajustar después de completar el circuito funcional. Un estilo de sprites de juego antiguo es una referencia visual, no una dependencia técnica.

El diseño aprobado para componer sprites, terreno e interacciones está en [animación](../architecture/animacion.md); mantiene el orden acordado de Probar, bloqueo, cálculo, animación opcional continua y resultado.

Quedan fuera de esta versión:

- Robot físico, hardware de robótica y el kiosco de empanadas.
- Control humano directo durante el intento, inferencias por frame, votaciones distribuidas por teléfono, ranking público global y soporte móvil o tablets.
- Editor de niveles o generación procedural obligatoria, segundo LLM traductor, generación de código en vivo, entrenamiento, fine-tuning y aprendizaje por refuerzo.
- GraphRAG, bases vectoriales, múltiples agentes y microservicios innecesarios.
- Salto largo, física libre, postura agachada persistente y uso manual o combinación de objetos.
- Generación de un archivo de video por intento y redespliegue de infraestructura al editar un prompt.

## Verificación de la experiencia

Al implementar, recorrer desde el acceso hasta editar, probar, recuperar, reproducir y volver a probar. Verificar que:

- **Probar** guarde el borrador y cree el snapshot sin un botón de aplicación separado;
- el toggle quede fijado por intento, tenga preferencia persistida y no altere inferencia ni métricas;
- durante cálculo sólo funcione **Cancelar**, y durante cualquier animación no haya controles operativos ni se pueda editar o navegar al historial;
- la reproducción avance de principio a fin a velocidad fija y sin controles de pausa, retroceso o salto, también cuando se inicia desde el resultado o el historial;
- el servidor pueda recuperar un cálculo tras recarga sin duplicar inferencia ni cuota;
- un conflicto o error antes de admitir conserve el borrador y no invoque agente ni cuota;
- `Animación` activado reproduzca antes de mostrar el resultado, mientras que desactivado muestre el resultado al cerrar el registro;
- error o cancelación sin acciones no produzca un replay vacío y los replays manuales del historial no llamen al modelo;
- el mapa de inspección agrupe por casilla de origen, mantenga la secuencia completa, muestre sólo la observación local y distinga una decisión sin acción de un turno consumido;
- la demostración use la integración real, dejando cualquier adaptador simulado claramente identificado como modo de prueba.
