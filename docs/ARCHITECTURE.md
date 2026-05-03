# Guardian Cloud — Architecture

## Visión general

Guardian Cloud se compone de cuatro bloques:

1. app móvil
2. backend ligero
3. base de datos gestionada
4. destino de almacenamiento del usuario

## 1. App móvil

Responsabilidades:
- capturar audio/vídeo
- fragmentar
- cifrar
- encolar
- subir
- reintentar
- recuperar estado tras fallo
- mantener subida activa con la app minimizada (Android foreground service)

Tecnologías reales (MVP actual):
- React Native / Expo (Dev Client, prebuild)
- AsyncStorage (`@react-native-async-storage/async-storage`) como cola
  persistente. Una sola clave `test.pending_retry` guarda un array de
  entries `PendingQueueEntry` (sesión + chunks + status). Lectura/escritura
  serializada con un `writeChain` para evitar carreras.
- expo-file-system para los archivos de grabación y los chunks en disco
- expo-av (audio) y expo-camera (vídeo)
- react-native-background-actions para el foreground service Android
  (notificación persistente "Guardian Cloud está protegiendo tu evidencia")

> SQLite NO se usa. Se evaluó al inicio y se descartó: AsyncStorage cubre
> el volumen real (chunks por sesión cuentan en decenas o cientos, no
> miles), elimina una dependencia nativa, y la cola es array-of-array sin
> joins. Si en el futuro el volumen exige SQLite la migración es local —
> el resto de la arquitectura no la nota.

## 2. Backend

Responsabilidades:
- auth auxiliar
- sesiones
- metadatos
- estado
- alertas
- health endpoints

Tecnologías previstas:
- Node.js
- Express
- Docker
- despliegue en homelab

## 3. Base de datos

Responsabilidades:
- usuarios
- relaciones familiares
- sesiones
- estados
- configuración

Tecnología:
- Supabase

## 4. Almacenamiento final

Destino del MVP actual:
- Google Drive (vía OAuth `drive.file`, carpeta `/GuardianCloud`)

Destinos futuros (NO en MVP):
- NAS del usuario (WebDAV sobre HTTPS — ver `NAS_DESTINATION_PLAN.md`)
- otros conectores cloud

> El MVP actual entrega Google Drive completo: subida proxied por el
> backend, dedup en dos capas (DB + nombre de archivo determinista),
> recovery tras kill, export por descarga inversa. NAS y otros destinos
> son una segunda iteración, no parte de v0.3.

## Flujo de datos

1. el usuario pulsa grabar
2. la app crea sesión
3. se generan chunks
4. se cifran localmente
5. se suben al destino
6. se actualiza estado en backend
7. al cerrar se completa la sesión

## Principios de arquitectura

- desacoplar app y backend
- no mezclar backend con almacenamiento final
- backend liviano
- reintento y tolerancia a fallo
- portabilidad futura a cloud

## Decisión clave

> El homelab aloja lógica y control, no el peso del almacenamiento.