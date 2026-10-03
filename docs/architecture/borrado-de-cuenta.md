# Borrado de cuenta a solicitud

El contacto publicado es `contacto@guilleojeda.com`. La solicitud debe llegar desde el email registrado; se verifica su correspondencia con el usuario de Cognito antes de eliminar datos. El procedimiento es manual y requiere acceso de operador a la cuenta `387483252302`, región `us-east-1`. No es una API pública ni una tarea automática del CI.

1. Resolver el usuario por su email en el User Pool vigente y conservar su `sub` para localizar los datos. Deshabilitarlo en Cognito para impedir nuevos accesos; la API consulta UserInfo en cada solicitud y rechaza la identidad deshabilitada.
2. Si hay un intento en curso, esperar su cierre o detener su sesión de Runtime antes de borrar. Comprobar que no quedan tareas pendientes de ese usuario que puedan volver a escribir. La sesión está guardada con el intento como `sessionId`.
3. Consultar todas las páginas de `PK = USER#<sub>` en `prompt-runner-game-drafts`. Conservar los IDs de los intentos antes de borrar sus cabeceras. Eliminar el borrador, los robots guardados, las cabeceras, las claves de idempotencia, cuotas y preferencia de animación de esa partición.
4. Eliminar todos los registros de `PK = ATTEMPT#<attemptId>` y los objetos bajo `attempt/<attemptId>/` del bucket privado de cuerpos de inferencia, para cada intento localizado. Revisar el prefijo completo, también si alguna escritura de cuerpo no quedó referenciada en DynamoDB.
5. Eliminar el usuario en Cognito y confirmar por consulta que no quedan datos de cuenta, configuraciones ni historial localizados. Informar que la solicitud fue atendida.

Los nombres del pool, bucket y Runtime se obtienen de los outputs de `PromptRunnerHosting`. DynamoDB y S3 requieren paginar; no alcanza con eliminar sólo la primera página ni sólo el usuario de Cognito. Los logs técnicos se administran aparte para diagnóstico y seguridad, como indica la política pública; no se promete eliminar de inmediato todos los logs o copias de operación.
