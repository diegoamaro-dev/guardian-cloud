# Guardian Cloud — MVP Scope

> **Este documento define ALCANCE, no estado de implementación.** «Entra en el
> MVP» significa que forma parte del objetivo, no que esté implementado ni
> validado. El estado real por niveles está en
> [`IMPLEMENTATION_STATUS.md`](./IMPLEMENTATION_STATUS.md).

## Entra en el MVP

- app móvil básica
- grabación manual
- chunks
- **cifrado local básico — PENDIENTE: no implementado.** En el código sólo
  existe `TODO(chunk-encryption)` en `mobile/app/index.tsx`; los chunks se
  suben sin cifrado en el cliente y no hay ninguna prueba que lo cubra. El
  transporte va sobre TLS, lo que **no** equivale a cifrado local. Ver
  [`SECURITY.md`](./SECURITY.md)
- cola persistente local
- reintentos
- backend mínimo
- Supabase para auth/metadatos
- integración inicial con Google Drive
- historial básico
- estado claro de grabación y subida

## No entra en el MVP

- modo Kids completo
- múltiples destinos
- NAS
- panel web completo
- pagos
- plan premium activo
- automatismos avanzados
- IA
- cadena de custodia avanzada
- exportación legal avanzada
- iOS con automatizaciones agresivas

## Métrica de éxito del MVP

> empezar a grabar, perder el móvil poco después y comprobar que al menos parte de la evidencia ha sobrevivido fuera del dispositivo.

## Aclaración

El MVP incluye:

* export básico de evidencia (reconstrucción desde chunks)

No incluye:

* exportación legal avanzada
* herramientas forenses externas
* validación jurídica
