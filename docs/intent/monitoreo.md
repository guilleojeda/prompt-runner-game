# Monitoreo administrativo

El monitor es una app separada del juego, con frontend estático propio en S3 y una Lambda de lectura. Su distribución CloudFront exige Basic Auth con el usuario `monitor` y la contraseña configurada por el operador. La protección cubre página, archivos y datos; los orígenes S3 y Function URL no permiten acceso anónimo directo. Las cuentas de jugadores siguen ingresando mediante Cognito en el juego.

El dashboard muestra el inventario actual de usuarios con `email_verified=true`, incluidas las cuentas deshabilitadas verificadas. Registrados no es un acumulado histórico de cuentas eliminadas. Nuevos cuenta la creación de esas cuentas dentro de ventanas móviles de 24, 72 y 168 horas, con un mismo corte UTC por consulta y ambos bordes incluidos. La lectura agota todas las páginas de Cognito y deduplica por `sub`. Cognito es eventualmente consistente: el corte temporal no promete un snapshot transaccional.

Actividad significa iniciar sesión exitosamente. Las fuentes actuales no permiten atribuir esos ingresos a cada cuenta ni conocer el gasto real de Bedrock por aplicación/usuario en las ventanas solicitadas. Activos, última sesión y costos conservan sus campos y muestran el string literal `N/A`. No se reemplaza gasto por reservas o estimaciones, ni desconocidos por cero.

La tabla muestra usuario, registro, última sesión y costos de Bedrock en 24 horas, 3 días y 7 días. Todas las columnas se ordenan en ambas direcciones: números como números, fechas por instante y texto en español; `N/A` queda al final y los empates se resuelven de forma estable. Las fechas se presentan en horario de Argentina.

Entrar, recargar o pulsar **Actualizar** consulta datos nuevos. Durante carga el botón queda deshabilitado y no se muestran resultados anteriores. Ante error se informa la falla y se permite reintentar manualmente. Un error operativo o inventario incompleto no se convierte en una respuesta parcial ni en `N/A`. Una consulta completa sin usuarios produce cero registrados/nuevos y una tabla vacía.

No hay polling, persistencia de resultados en el navegador ni caché de métricas. Los archivos con hash pueden usar caché HTTP normal, después de validar el acceso en cada solicitud. El navegador administra las credenciales Basic; la app no almacena contraseñas ni incorpora credenciales AWS. La Lambda sólo puede listar usuarios del pool existente y escribir sus logs operativos; no escribe datos del juego ni invoca inferencia.

La configuración y entrega están en [acceso y entrega](../architecture/acceso-y-entrega.md#monitor-administrativo).
