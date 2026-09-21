# Persistencia, historial y cuota

**Borrador persistido implementado; almacenamiento del juego y política diaria aprobados, todavía pendientes.** El [contrato lógico del registro](registro-de-ejecucion.md) y la [presentación](animacion.md) están aprobados. Complementa [ejecución](ejecucion.md) y respeta los requisitos de [intentos](../intent/intentos.md), [consumo](../intent/consumo-y-puntaje.md) y [plataforma](../intent/plataforma.md).

## Borrador disponible

La API expone GET y PUT `/draft` para la cuenta verificada. El `sub` del access token validado es el único selector de propietario; el cliente no elige otro usuario. La tabla on-demand usa `PK=USER#<sub>`, `SK=DRAFT` y conserva `version`, fecha del servidor y borrador. No tiene TTL ni índices; CDK retiene la tabla ante eliminación o reemplazo. No se guarda un historial por cada pulsación: las versiones de edición controlan concurrencia, mientras los snapshots inmutables pertenecen a los futuros intentos.

GET lee con consistencia fuerte. Si todavía no existe un registro, devuelve el default y versión cero sin escribir. PUT recibe `{expectedVersion, draft}`; crear exige ausencia del ítem, y actualizar exige que coincida la versión. La condición y el incremento son una sola escritura atómica. Un conflicto devuelve HTTP 409 y la versión actual de la misma cuenta. Elegir reemplazarla desde el editor vuelve a usar una condición; no existe escritura forzada.

Una respuesta de PUT perdida puede corresponder a una escritura confirmada. El cliente consulta el servidor: si encuentra el snapshot enviado adopta su versión, si sigue en la versión base permite repetir la escritura, y si encuentra una versión posterior diferente muestra conflicto. Mientras no puede comprobarlo, no afirma Guardado. Los cambios escritos después del envío se conservan por separado del snapshot en vuelo.

El contrato compartido valida forma y catálogo; reconstruye IDs/schemas desde definiciones del proyecto y mide 65.536 bytes máximos de JSON UTF-8 expandido, sin metadatos de transporte o propietario. Un rechazo por forma o tamaño conserva el registro anterior. No se recortan textos, no se corrigen instrucciones y cero habilidades es guardable. Si el registro guardado tiene un formato o catálogo incompatible, la API devuelve `stored_draft_incompatible` y el editor informa el problema sin mostrar defaults editables ni reinicializar los datos. Este error se distingue de una dependencia temporalmente inaccesible.

## DynamoDB y S3

Usar **DynamoDB on-demand para datos estructurados y S3 privado para conservar completos los requests y responses de inferencia**. No se necesita una base relacional: los accesos principales son configuración e historial por usuario, intento por identificador, eventos ordenados y victorias comparables propias. No hay joins exploratorios ni ranking global requerido.

| Dato | Autoridad y representación |
|---|---|
| Propietario | El `sub` validado por Amazon Cognito determina el propietario y aísla sus datos. |
| Borrador | Documento DynamoDB por usuario con versión para controlar ediciones concurrentes. |
| Configuración del intento | Versión inmutable del borrador visible al pulsar Probar, con instrucciones, selección, descripciones, IDs opacos y schemas. |
| Presentación | Preferencia de Animación por usuario, valor fijo capturado por intento y marca de presentación terminada para recuperar la UI. No forman parte del payload del modelo ni del puntaje. |
| Nivel, motor, protocolo e inferencia | Versiones publicadas inmutables; cada intento fija las que usó. |
| Cuota | Contador por usuario y fecha, actualizado atómicamente al admitir. |
| Intento | Cabecera pequeña con propietario, referencias fijas, estado, ejecutor, secuencia, cancelación y métricas. |
| Decisión y llamada | Ítems separados y ordenados; observación, elección, validación, uso y referencias a bodies. |
| Acción y estado | Evento de acción publicado con resolución y snapshot posterior; referencia al estado anterior, sin duplicarlo. Fases efectivas materializadas en cada snapshot. |
| Cuerpo de request y response | Objetos S3 privados por intento, decisión y ordinal de llamada. Se conserva el request y response completos, incluso si la respuesta es inválida o contiene un error del proveedor. |
| Historial y clasificación propia | Índices por usuario/fecha y usuario/nivel/reglas/puntos, sin leer todo el registro de llamadas. |

El diseño lógico no exige una tabla por fila de esta lista ni múltiples bases. El esquema físico agrupa accesos compatibles y usa consultas paginadas. El historial puede tolerar el pequeño retraso de un índice; la pantalla del intento recién creado consulta su cabecera directamente y consistentemente. Las condiciones de admisión, pertenencia y cierre no dependen de índices eventualmente consistentes.

No hay TTL ni expiración de objetos del producto. Niveles y configuraciones anteriores siguen accesibles por sus referencias aunque haya nuevas versiones. Los cuerpos de inferencia nunca se publican mediante la distribución del frontend; la API comprueba pertenencia antes de devolverlos o emitir un enlace de lectura de corta duración.

El toggle de Animación no altera qué datos se guardan. Todos los intentos conservan eventos, llamadas, snapshots y métricas completos; omitir la animación automática no impide un replay manual posterior. El bloqueo del editor en la pantalla no sustituye el control de versión del borrador ni la idempotencia y cuota del servidor.

El [contrato de registro](registro-de-ejecucion.md) conserva un estado inicial y otro después de cada acción, con referencias encadenadas y resultado explícito. La API proyecta de esos mismos datos la información de reproducción, sin duplicar un historial visual ni exigir descargar los bodies del modelo. El cierre fija la secuencia completa que debe cargar el navegador. La [marca de presentación](animacion.md#integración-con-probar-y-el-resultado) permite distinguir una animación pendiente de un resultado ya presentado, sin persistir progreso por frame.

## Tamaño y separación de cuerpos

Un intento entero no cabe necesariamente en un ítem DynamoDB de 400 KiB. Separar eventos evita ese problema, pero tampoco garantiza que un request o response completo quepa en un ítem. Un `max_tokens` pequeño no establece un máximo de bytes de todo el JSON ni sus metadatos.

Los cuerpos completos de requests y responses se guardan en objetos S3 privados y DynamoDB conserva referencias y metadatos acotados. Así el tamaño del body no obliga a fragmentar o truncar el registro estructurado. Los ítems de DynamoDB deben respetar el límite del servicio; cualquier validación de tamaño de una configuración o metadato es una decisión de implementación y no introduce un límite de producto en este documento. No se presume una equivalencia entre caracteres, tokens y bytes.

Default de implementación adoptado para el borrador y previsto para la configuración aplicada: **64 KiB de JSON UTF-8 serializado**, medidos antes de guardarla y antes de admitir el intento. El editor informa el límite y rechaza sin truncar ni corregir textos. El catálogo y mapas los produce el proyecto; sus snapshots y los ítems generados se validan con margen por debajo de 400 KiB. Los cuerpos del proveedor permanecen fuera de esos ítems; la metadata normalizada conserva campos acotados.

## Escritura y cierre

1. Guardar el request completo en S3; registrar la llamada iniciada en DynamoDB, incluida la clave prevista del objeto de respuesta y con condición de ejecutor, estado y ausencia de cancelación. Solo después enviar a Bedrock.
2. Guardar el body de respuesta completo antes de validar la acción. Los errores HTTP del proveedor también quedan registrados cuando se recibe su cuerpo. Guardar tamaño/checksum y uso original o su referencia.
3. Validar y normalizar; publicar evento de acción, snapshot posterior y cabecera mediante transacción condicionada por ejecutor, secuencia, estado y cancelación. El snapshot anterior ya existe. Una respuesta inválida queda auditada sin acción ni turno consumido.
4. Cerrar desde las llamadas y eventos guardados; publicar el resultado clasificable solo si corresponde. La reproducción lee el registro cerrado y sus snapshots, no recalcula la física con la última versión de código.

No existe una transacción distribuida entre Bedrock, S3 y DynamoDB. Si S3 confirmó la respuesta y falló su metadata, la clave previamente registrada permite recuperarla para diagnóstico y métricas; eso no autoriza reanudar el juego perdido. Si el proceso muere antes de guardar la respuesta, la llamada queda con resultado y uso desconocidos. Una falla permanente de almacenamiento no se disfraza como registro completo. Se puede reintentar guardar exactamente el mismo body sin nueva inferencia.

El único ejecutor y las claves por ordinal evitan que un retry cambie una llamada anterior. Las escrituras de datos inmutables usan condiciones que impiden reemplazos con contenido diferente. Los objetos que se hayan guardado sin completarse la metadata quedan bajo el prefijo identificable del intento; no se añade un servicio de limpieza o reconciliación continua para esta versión.

## Política diaria

La cuota inicial es de **100 intentos por usuario y día**, configurable:

- El día de calendario usa `America/Argentina/Buenos_Aires` y se reinicia a las 00:00 de Argentina, mostrado en la UI. El servidor decide la fecha; no acepta la del cliente.
- Se contabiliza cuando se admite y persiste el intento, mediante la misma transacción que lo crea y una condición de contador menor al límite.
- Rechazos previos a admisión, envíos duplicados y reproducciones no consumen cuota.
- Cancelaciones y errores posteriores a admisión conservan el consumo de ese intento. No hay reintegro automático; la UI lo comunica antes de iniciar.
- La idempotencia asocia usuario, clave y huella del contenido de inicio. Se comprueba antes de evaluar una nueva cuota: un reenvío de la misma solicitud sigue devolviendo su intento aunque el contador haya llegado al límite.

## Métricas e historial

Los turnos son acciones publicadas; las llamadas y reintentos son registros de inferencia. Los tokens se agregan con la semántica del proveedor y no se suman dos veces las categorías de caché. Un valor desconocido sigue desconocido, aunque el intento haya avanzado. El cierre y el diagnóstico muestran lo recuperable sin fabricar un costo o puntaje exacto.

Solo victorias con métricas suficientes ingresan a la comparación del mismo usuario, nivel y versión de puntuación. Los parámetros numéricos del puntaje y los desempates se fijan como defaults visibles al implementar, según [la fórmula acordada](../intent/consumo-y-puntaje.md); no hace falta pedirlos ahora ni calibrar el efecto educativo para aceptar esta arquitectura.

Se debe comprobar concurrencia de admisión, deduplicación atravesando medianoche, pertenencia entre dos usuarios, edición concurrente, cierre frente a cancelación, escritura ambigua y recuperación de cuerpos. La retención del producto se protege en CDK evitando destrucción de tablas, buckets y usuarios durante despliegues ordinarios; eso no equivale a prometer un RPO/RTO o servicio de recuperación no solicitado.
