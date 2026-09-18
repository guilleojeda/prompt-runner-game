# Plataforma y operación

Especificación acordada del producto. El código disponible implementa la entrada React mínima y el circuito de publicación S3/CloudFront por CDK y GitHub Actions; su primera publicación real sigue pendiente de verificación. Identidad, backend, persistencia y ejecución del juego siguen pendientes; las secciones correspondientes describen el objetivo aprobado, no capacidades ya disponibles. [Índice de documentación](../../README.md).

## Tecnologías y restricciones confirmadas

| Área | Decisión o preferencia |
|---|---|
| Frontend | React, para navegadores de escritorio. |
| Backend web | TypeScript en AWS Lambda. |
| Ejecución del agente | AgentCore Runtime con Strands en TypeScript. El ejecutor reúne coordinación del intento, motor y registro. |
| Infraestructura como código | AWS CDK en TypeScript. |
| Inferencia | Amazon Bedrock mediante el proveedor nativo `BedrockModel` de Strands y Converse sin streaming. Modelo inicial: Claude Sonnet 5, perfil `global.anthropic.claude-sonnet-5`. No se usa Mantle. |
| Almacenamiento | DynamoDB en modo on-demand para datos estructurados y S3 privado para conservar completos los requests y responses de inferencia. |
| Identidad y correo | Amazon Cognito User Pool con Managed Login Essentials en español, email y contraseña, confirmación por código y recuperación administrada. La primera versión usa el correo predeterminado de Cognito y mensajes estándar, con el límite publicado de 50 correos diarios; SES propio y `SourceArn` quedan para una fase posterior. |
| Hosting | React estático en un bucket S3 privado, servido por CloudFront con Origin Access Control (OAC). El build y la publicación se integran con CDK en TypeScript y GitHub Actions. Puede comenzar con URLs AWS para web, identidad y API; no se exige dominio propio en esta fase. |
| Ambiente inicial | Un único ambiente; sus actualizaciones afectan al público. |
| Cuenta y región | Cuenta `387483252302`, aplicación en `us-east-1`. La inferencia puede usar otras regiones si simplifica la solución. |
| Entrega | GitHub Actions para CI; CI/CD con despliegue automático. Repositorio: [guilleojeda/prompt-runner-game](https://github.com/guilleojeda/prompt-runner-game). |

Lambda aloja el backend web y AgentCore Runtime ejecuta el intento con Strands. La arquitectura preserva el [contrato del agente](agente.md), incluida la independencia entre decisiones y el control determinista de las acciones. Sus responsabilidades y fundamentos están en [ejecución](../architecture/ejecucion.md). El acceso al modelo y sus cuotas se resuelven en Bedrock; no justifican cambiar automáticamente de servicio o modelo.

Priorizar la solución más simple que funcione bien, con bajo costo de infraestructura, inferencia y mantenimiento. Las buenas prácticas deben proteger el comportamiento y la entrega de esta aplicación; no justifican añadir componentes, capas o mecanismos sin una necesidad concreta. Las separaciones entre motor, observación, catálogo, inferencia, registro e interfaz son responsabilidades de software, no una exigencia de desplegar un servicio por responsabilidad o por habilidad.

## Usuarios, acceso y cuota

El registro está abierto a cualquier persona con un email que pueda verificar. La primera versión usa un User Pool de Amazon Cognito, Managed Login Essentials en español, email y contraseña, confirmación por código y recuperación administrada. Se usa el correo predeterminado de Cognito, con mensajes estándar y sin requisito de traducción propia; no se configura SES propio ni `SourceArn` en esta fase. La verificación debe comprobar acceso a la casilla: si se agota el límite publicado de **50 correos diarios** de Cognito, la interfaz informa el impedimento. Si un alta dejó un usuario `UNCONFIRMED`, conserva ese estado y permite reenviar cuando corresponda; nunca aprueba el email automáticamente. Un fallo de envío no desconfirma usuarios ya verificados. El límite de correo de Cognito es independiente de la cuota de 100 intentos diarios, de la concurrencia objetivo de 100 usuarios y de cualquier otra métrica de la aplicación. En una fase posterior se agregará SES sin reemplazar el User Pool ni los usuarios existentes.

Cada usuario dispone inicialmente de **100 intentos por día**, con un límite configurable. La cuota se contabiliza al admitir y persistir el intento en el servidor. El día de cuota usa `America/Argentina/Buenos_Aires` y se reinicia a medianoche de Argentina; la fecha la determina el servidor, no el cliente. Rechazos previos a la admisión, solicitudes duplicadas y reproducciones de registros existentes no consumen cuota. Una cancelación o un error posterior a la admisión conserva el consumo del intento y no tiene reintegro automático.

Una reproducción de un registro existente no crea un nuevo intento ni vuelve a consumir inferencia. La cuota se mantiene aunque se hagan solicitudes desde varias pestañas o sesiones de la misma cuenta. La admisión debe ser idempotente para que un reenvío de la misma solicitud duplicada no consuma otra unidad.

El jugador accede a sus propias configuraciones, objetos, intentos, resultados y registros. El servidor mantiene esa separación incluso si un cliente intenta consultar o modificar identificadores de otra cuenta. La existencia de cuentas no agrega un ranking público, roles administrativos ni un panel de administración como requisitos.

## Información conservada

Toda la información de la aplicación se conserva en el servidor, incluida la configuración del robot, sus versiones, los niveles asociados a cada intento, los eventos, observaciones, llamadas, resultados y métricas. Un usuario puede volver a ingresar desde otro navegador de escritorio y recuperar sus configuraciones e historial reproducible.

Se conserva también la preferencia de Animación y su valor fijado al pulsar Probar para cada intento. Desactivarla solo omite la reproducción automática: el servidor calcula y guarda el mismo registro completo. El flujo de bloqueo, animación opcional y resultado se define en [experiencia](experiencia.md).

No se definió una duración de conservación ni se requiere caducidad automática. La persistencia del producto no se reduce a la memoria del navegador o a la vida de una ejecución del agente. El registro necesario para que una reproducción anterior siga siendo fiel se define en [intentos](intentos.md).

El cálculo continúa al cerrar o recargar la página mediante la tarea de background de Runtime. Al volver, la interfaz recupera el intento y el valor de Animación fijado al pulsar Probar. Una caída del ejecutor conserva lo ya registrado y se informa como error; no hay reanudación automática del juego tras una falla de infraestructura. Los límites y la coordinación están en [ejecución](../architecture/ejecucion.md).

## Capacidad y costo

La capacidad objetivo es de hasta **100 usuarios simultáneos**, con menos de 10 como uso habitual esperado. Las cuotas y permisos reales de la cuenta y del modelo deben comprobarse antes de afirmar que esa capacidad está disponible.

No hay un presupuesto máximo fijado ni un corte global de gasto solicitado. La cuota por usuario sí es obligatoria y el bajo costo es una prioridad de las elecciones técnicas. Los costos de inferencia deben basarse en consumos reales y tarifas verificadas cuando se muestren; no se promete un costo mensual sin conocer el uso. Véase [consumo y puntuación](consumo-y-puntaje.md).

El tiempo de cálculo no es una restricción de experiencia fijada por el usuario. Los límites técnicos de los servicios siguen siendo hechos que la solución debe respetar para terminar o informar una ejecución correctamente; no se convierten en un nuevo objetivo de latencia.

## Configuración, seguridad y entrega

Las credenciales y secretos permanecen fuera del frontend y de los archivos públicos. El usuario proporcionará acceso a AWS cuando sea necesario. La cuenta de destino indicada no equivale a haber verificado permisos, cuotas, acceso a modelos ni recursos existentes.

Las descripciones e instrucciones del público solo influyen en la selección de acciones del catálogo del juego. No otorgan acceso a secretos, herramientas externas ni ejecución de código generado. Los esquemas y efectos reales pertenecen a la implementación; el servidor valida las solicitudes antes de ejecutarlas.

La configuración del modelo, parámetros de inferencia, límites de turnos, cuota diaria, pesos, valores de objetos y niveles debe estar documentada. Cuando se muestre dinero, también las tarifas y su fecha. Un cambio en las habilidades o instrucciones del jugador no requiere un despliegue ni crear nuevos recursos de agente.

La entrega usa pull requests con checks y despliegue automático desde `main` mediante GitHub Actions, OIDC y CDK en TypeScript. El ambiente es único y sus actualizaciones afectan al público. [README](../../README.md#desarrollo-local) describe la instalación y los comandos; [acceso y entrega](../architecture/acceso-y-entrega.md) conserva la preparación y operación. La entrada actual puede desarrollarse y verificarse sin credenciales ni inferencia. Cuando se incorpore el agente se documentará su modo de prueba sin inferencia real.

## Hechos y elecciones pendientes antes de implementar

Las capacidades publicadas y sus límites se conservan en referencias técnicas. Estas fuentes permiten comparar soluciones; no convierten una alternativa en decisión aprobada.

| Tema | Base factual | Elección o verificación todavía necesaria |
|---|---|---|
| Runtime + Strands | [AgentCore](../reference/agentcore.md) | Implementar y verificar decisiones independientes, herramientas, registro y continuidad. La arquitectura está elegida. |
| Bedrock | [APIs, métricas y tarifas](../reference/bedrock.md) | Habilitar acceso/cuotas y verificar Sonnet 5 mediante la integración nativa. API y modelo inicial están elegidos. |
| Acceso por email | [Identidad y correo](../reference/identidad.md) | Cognito Managed Login Essentials con correo predeterminado, confirmación y recuperación; falta implementarlo y verificar el límite de correo. SES propio queda para una fase posterior. |
| Cálculo independiente del navegador | [Tareas y sesiones](../reference/agentcore.md#continuidad-sesión-y-almacenamiento) | Verificar la tarea de background y la recuperación del intento y su presentación al recargar. |
| DynamoDB y registros | [Contrato de registro](../architecture/registro-de-ejecucion.md) y [datos](../architecture/datos.md) | Almacenamiento on-demand y S3 privado decididos; faltan implementación, accesos y verificación operativa. |
| Despliegue | [CDK y GitHub Actions](../reference/datos-y-entrega.md) | La topología React estático en S3 privado con CloudFront/OAC y publicación mediante CDK TypeScript y GitHub Actions está decidida; faltan implementación, permisos, URLs AWS y verificación operativa. El ambiente inicial es único. |

El estado observado mediante lecturas de la cuenta se documenta por separado en [cuenta AWS](../reference/cuenta-aws.md). Una consulta de cuota o disponibilidad no prueba la capacidad de la aplicación ni una inferencia exitosa.

Los mapas, los pesos y la calibración educativa se ajustan en el momento acordado en [experiencia](experiencia.md). Las comprobaciones de integración no reabren por sí solas las decisiones finales.

## Verificación de la plataforma

Al implementar, comprobar registro con email verificado, acceso a datos propios, recuperación entre sesiones y aplicación del límite diario ante solicitudes concurrentes. Verificar que ni el contexto del agente ni los recursos públicos contienen secretos o datos de otras cuentas. Probar continuidad al cerrar la página y recuperación con el valor de Animación fijado para el intento.

La entrega debe demostrar que el resultado desplegado corresponde a cambios verificados por el circuito configurado y que el flujo real puede usar Bedrock, persistir un intento y recuperarlo. Las pruebas de capacidad y las cuotas observadas deben respaldar lo que se afirme sobre los 100 usuarios simultáneos, sin inventar un objetivo de latencia o una exigencia adicional de disponibilidad.
