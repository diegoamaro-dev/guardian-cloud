# Guardian Cloud — API Spec v1

## Objetivo

Definir la API mínima del MVP.

## Auth

### POST /auth/login
Inicia sesión o intercambia token con proveedor externo.

### POST /auth/logout
Cierra sesión.

## Sesiones

### POST /sessions
Crea una sesión de grabación.

Body:
- user_id
- mode
- destination_type

Response:
- session_id
- created_at
- status

### GET /sessions/:id
Devuelve estado de sesión.

### POST /sessions/:id/complete
Marca sesión como completada.

## Chunks

### POST /chunks
Registra chunk subido o recibido.

Body:
- session_id
- chunk_index
- hash
- size
- status
- remote_reference

### GET /sessions/:id/chunks
Lista chunks de una sesión.

## Destinos

### GET /destinations
Lista destinos configurados por el usuario.

### POST /destinations/drive/connect
Inicia conexión con Google Drive.

### POST /destinations
Guarda configuración de destino.

## Alertas

### POST /alerts
Crea alerta asociada a una sesión.

### GET /alerts
Lista alertas del usuario.

## Salud

### GET /health
Estado básico del backend.

## Notas

- la API v1 no debe ser enorme
- primero debe ser estable
- la fuente de verdad crítica es el estado de sesión y chunk