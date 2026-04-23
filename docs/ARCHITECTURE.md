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

Tecnologías previstas:
- React Native / Expo
- SQLite local
- sistema de archivos local

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

Destinos iniciales:
- Google Drive
- futuro NAS
- futuros conectores

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