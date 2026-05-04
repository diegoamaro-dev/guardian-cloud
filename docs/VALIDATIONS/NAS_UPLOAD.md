# NAS Upload Validation

## Fecha
2026-05-04

## Resultado
OK

## Flujo probado
- grabación audio
- chunking incremental
- subida en tiempo real a NAS (WebDAV)
- metadata registrada en backend
- completion gate superado
- sesión completada correctamente
- limpieza de archivo local

## Evidencia
- logs app: POST /destinations/nas/chunks
- chunks presentes en:
/var/www/webdav/GuardianCloud/{session_id}/

## Notas
- routing correcto a NAS tras fix de race condition
- no se detectaron uploads a Drive en este flujo

## Recovery con destino NAS

Resultado: OK

Validado:
- cola pendiente tras fallo/red
- drain bloqueado hasta resolver destino
- destino resuelto como NAS
- chunks subidos a /destinations/nas/chunks
- completion gate 3/3
- sesión completada
- cleanup local

Logs clave:
- GC_QUEUE blocked: destination not resolved
- DEST_TYPE {"activeDestinationType":"nas","destinationResolved":true}
- POST /destinations/nas/chunks
- GC_QUEUE session completed