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

## Evidence Manifest (futuro)

### GET /sessions/:id/manifest

Devuelve el manifest de reconstrucción de una sesión.

Response:

```json
{
  "session_id": "...",
  "mode": "audio",
  "format": "m4a",
  "chunks": [
    {
      "index": 0,
      "hash": "...",
      "size": 16384,
      "remote_reference": "drive_file_id"
    }
  ]
}
```

---

### Notas

* NO es necesario para el MVP
* se basa en datos ya existentes (`chunks`)
* no introduce nueva lógica de negocio
* permite reconstrucción externa sin app

---

### Decisión

> El manifest es una vista derivada, no una entidad nueva

Se genera a partir de:

* tabla de chunks
* metadata de sesión

---

### Motivación

Permitir:

* reconstrucción manual
* uso forense
* independencia del cliente

---

### Restricciones

* debe ser idempotente
* no duplicar datos
* no introducir estado adicional
