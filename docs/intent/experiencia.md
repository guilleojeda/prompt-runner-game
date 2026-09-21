# Experiencia y alcance

Especificación vigente de la experiencia. El acceso y la preparación persistida del robot están implementados. El circuito de partidas y animación sigue pendiente. Se relaciona con [intentos](intentos.md), [agente](agente.md), [reglas del juego](juego.md), [consumo y puntaje](consumo-y-puntaje.md) y [plataforma](plataforma.md).

## Propósito y participantes

El juego muestra cómo las habilidades disponibles, sus descripciones y las instrucciones generales influyen en un agente basado en un LLM. La persona configura al agente; el motor resuelve el recorrido con reglas deterministas; el reproductor presenta el registro cerrado. El personaje es un robot virtual y toda la actividad ocurre en pantalla.

El contexto de presentación es un espacio aproximado de 30 minutos de AWS User Group AI Argentina en el booth de AWS de Nerdearla. La primera versión prioriza completar el circuito funcional; no agrega como condición una duración máxima de cálculo, una cantidad fija de intentos, una tasa de éxito del modelo ni una secuencia educativa garantizada.

La interfaz está en español y debe poder entenderse sin conocer AWS ni programación. La duración del cálculo no es un criterio de rechazo ni una condición adicional de aceptación.

## Formas de uso

- **Sesión colaborativa:** los presentadores operan una única interfaz desde una computadora de escritorio conectada a un proyector. El público propone habilidades, descripciones e instrucciones y observa los resultados. Los asistentes no necesitan teléfono, cuenta ni conexión propia para participar verbalmente.
- **Juego individual:** cada participante entra a la aplicación web desde un navegador de escritorio, crea una cuenta con email verificado y usa las mismas mecánicas y posibilidades de edición. El registro, la cuota y el guardado se definen en [plataforma](plataforma.md).

La primera versión no requiere soporte para celulares o tablets. El booth y el juego individual usan las mismas reglas y los dos recorridos previstos; sólo cambia quién opera la interfaz. La pantalla compartida debe mantener texto reconocible, obstáculos distinguibles y resultados visibles desde el proyector.

## Preparación disponible

La vista privada muestra las habilidades, sus descripciones e instrucciones y guarda automáticamente al dejar de escribir durante 600 ms. La persona puede seguir editando mientras se guarda una versión anterior; el aviso Guardado sólo corresponde al texto visible confirmado por el servidor. Hay estados de carga, cambios pendientes, guardado, error con reintento, límite de bytes y conflicto entre pestañas.

Un conflicto conserva el texto local y permite revisar la versión guardada antes de elegir cuál conservar. La resolución vuelve a comprobar la versión para no pisar una tercera edición. La renovación de la misma sesión pausa las escrituras y bloquea los controles del editor sin descartar cambios pendientes; otra identidad nunca hereda esos cambios. Al cerrar sesión con cambios sin confirmar se ofrece esperar/reintentar o descartar explícitamente los cambios locales pendientes. Una escritura ya enviada puede haber quedado guardada; salir no promete revertirla y no espera indefinidamente a la red. La cola local se detiene. La advertencia nativa al salir no garantiza guardar después de un cierre abrupto.

La pantalla está en español y se opera con teclado. No ofrece Probar, selector de nivel, historial o Animación hasta que esas capacidades estén disponibles. El circuito objetivo se mantiene a continuación.

## Circuito de una partida

1. La persona accede a su cuenta y selecciona o revisa el recorrido y la configuración.
2. Edita el borrador: habilita capacidades del catálogo, escribe sus descripciones y modifica las instrucciones generales.
3. Ajusta el toggle **Animación**. Está activado por defecto, es ajustable y el servidor conserva esa preferencia para futuros intentos; el valor vigente se captura de nuevo en cada clic en **Probar**.
4. Hace clic en **Probar**. Los controles se bloquean inmediatamente mientras se valida la admisión y se guarda el borrador visible. El intento fija nivel, configuración, parámetros de puntuación y el valor actual de **Animación**. No hay un botón separado para aplicar el borrador.
5. Si el servidor admite el intento, inicia el cálculo secuencial y conserva el registro. La interfaz muestra «Preparando intento» y bloquea la edición.
6. Cuando el registro queda cerrado, si el snapshot tiene `Animación` activado, la interfaz reproduce automáticamente el registro completo. Al terminar muestra el resultado; si está desactivado, salta la reproducción y muestra el resultado de inmediato.
7. La persona consulta el resultado, compara intentos, modifica el borrador y vuelve a hacer clic en **Probar**.

El snapshot de **Animación** es sólo una decisión de presentación para ese intento. No cambia el prompt, las herramientas, las llamadas, los tokens, los turnos, el puntaje, la cuota ni el registro. Ambas rutas guardan siempre el registro completo, las métricas y los recursos necesarios para reproducirlo después desde el historial.

## Estados de la interfaz y controles

Los estados de la interfaz describen qué puede hacer la persona. No son una copia de los estados del job del servidor: el job puede haber terminado mientras la interfaz sigue reproduciendo la animación automática.

| Estado de interfaz | Controles habilitados | Comportamiento |
| --- | --- | --- |
| Edición | Campos, nivel, toggle, **Probar** e historial | Se modifica el borrador y se puede iniciar una admisión |
| Guardando o admitiendo | Ningún control operativo mientras se confirma la admisión | Si hay conflicto o error antes de admitir, se conserva el borrador, no se usa cuota ni agente y se vuelve a Edición |
| Cálculo | Sólo **Cancelar** | Se bloquean campos, habilidades, nivel, toggle, **Probar**, historial e inicio de otras visualizaciones |
| Animación automática | Ninguno | Avanza a velocidad fija, hacia adelante y sin interrupciones; campos, habilidades, nivel, toggle, **Probar** e historial siguen bloqueados hasta terminar |
| Resultado | Campos, nivel, toggle, **Probar** e historial | Se consulta el resultado y se puede iniciar otro intento |
| Visualización desde resultado o historial | Ninguno mientras se reproduce | Una vez iniciada, avanza automáticamente de principio a fin a la misma velocidad fija; no hay inferencia ni edición o navegación durante la reproducción |

Durante el cálculo **Cancelar** es el único control operativo. No se habilita edición parcial ni se permite cambiar el nivel, el toggle o las instrucciones hasta que el intento llegue a un estado terminal. La animación se muestra completa, en orden y a una única velocidad fija. Durante ella no hay controles para pausar, retroceder, avanzar, saltar turnos, reiniciar ni modificar la velocidad. El bloqueo continúa hasta presentar el resultado.

Una cancelación o un error sin acciones ejecutadas no inicia una reproducción vacía: muestra el resultado con su causa y desbloquea la interfaz. Si existe un registro parcial cerrado con acciones, se aplican las reglas de reproducción de [intentos](intentos.md) según el valor de **Animación** guardado. Un error o cancelación nunca se presenta como derrota del robot.

## Recarga y recuperación

El estado del intento en curso y el valor de **Animación** fijado al hacer clic en **Probar** se conservan en el servidor. Si la página se recarga durante el cálculo, recupera el intento y vuelve al estado de cálculo con los controles bloqueados; no crea otra inferencia ni otra cuota. Si el job ya terminó pero la interfaz todavía debe reproducir automáticamente, recupera el registro cerrado y mantiene bloqueadas la edición y la consulta del resultado hasta terminar la reproducción. La reproducción recuperada no llama al modelo.

Los estados de resultado no se consultan ni permiten editar mientras una animación automática recuperada siga pendiente. Una vez terminal y terminada la presentación, el resultado queda disponible. Los replays manuales desde el historial se pueden iniciar después del resultado y nunca crean inferencias nuevas.

## Edición y diagnóstico

La vista principal reúne el recorrido y el robot, las habilidades, sus descripciones, las instrucciones generales, el toggle **Animación**, **Probar**, el historial y los resultados. No requiere editar JSON, código, schemas ni infraestructura.

Cada habilidad presenta su nombre humano, si está habilitada, su descripción y sus parámetros en términos comprensibles. El identificador opaco puede consultarse en el diagnóstico. La información explicativa para la persona no se convierte automáticamente en instrucciones del modelo; ese límite pertenece al [contrato del agente](agente.md). No se requiere un sistema complejo de control de versiones para las configuraciones.

El borrador se mantiene separado del snapshot de cada intento. Un clic en **Probar** guarda directamente el contenido vigente y lo fija para el intento admitido. Si la validación, el guardado o la detección de conflicto fallan antes de admitirlo, se conserva el borrador, se muestran el error y su causa, y la interfaz vuelve a estar disponible. No se consume cuota ni se llama al agente en ese caso.

El diagnóstico permite inspeccionar, para una decisión, la observación, el prompt efectivo con su protocolo, las herramientas y descripciones enviadas, la herramienta elegida y sus argumentos, el resultado del motor y el uso real. El diagnóstico no es necesario para operar los controles principales.

## Resultados

La vista de resultado muestra si el recorrido terminó en victoria, derrota, límite, cancelación o error, junto con los turnos, objetos, tokens reales y puntaje cuando corresponde. Una derrota muestra la acción registrada y el obstáculo que la provocó, por ejemplo «Intentó caminar por un pozo»; no presenta una explicación inventada como pensamiento real del modelo. El costo monetario es opcional cuando hay datos suficientes y se identifica como estimado según [consumo y puntaje](consumo-y-puntaje.md).

## Contenido educativo y alcance

La configuración inicial tiene una limitación real en capacidades, descripciones o instrucciones. La frase de preferir la derecha forma parte de las instrucciones iniciales y es editable según [agente](agente.md). El catálogo, la física y los dos recorridos están en [juego](juego.md).

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

Al implementar, recorrer desde el acceso hasta editar, probar, recuperar, reproducir, comparar y volver a probar. Verificar que:

- **Probar** guarde el borrador y cree el snapshot sin un botón de aplicación separado;
- el toggle quede fijado por intento, tenga preferencia persistida y no altere inferencia ni métricas;
- durante cálculo sólo funcione **Cancelar**, y durante cualquier animación no haya controles operativos ni se pueda editar o navegar al historial;
- la reproducción avance de principio a fin a velocidad fija y sin controles de pausa, retroceso o salto, también cuando se inicia desde el resultado o el historial;
- el servidor pueda recuperar un cálculo tras recarga sin duplicar inferencia ni cuota;
- un conflicto o error antes de admitir conserve el borrador y no invoque agente ni cuota;
- `Animación` activado reproduzca antes de mostrar el resultado, mientras que desactivado muestre el resultado al cerrar el registro;
- error o cancelación sin acciones no produzca un replay vacío y los replays manuales del historial no llamen al modelo;
- la demostración use la integración real, dejando cualquier adaptador simulado claramente identificado como modo de prueba.
