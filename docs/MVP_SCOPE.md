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
- **continuidad de protección al pasar a segundo plano** — al minimizar la app o
  bloquear la pantalla, el vídeo se detiene de forma controlada y la protección
  continúa mediante audio, sin decisión del usuario. *Alcance aprobado, **no
  implementado**; decide
  [`decisions/ADR-CONTINUOUS-PROTECTION.md`](./decisions/ADR-CONTINUOUS-PROTECTION.md)*

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
- **captura de vídeo en segundo plano** — prohibida por decisión de producto, no
  diferida
- **retorno automático a vídeo** al volver la app a primer plano — *diferido, no
  rechazado*
- **export final multi-fase** de una sesión con vídeo y audio

## Métrica de éxito del MVP

> empezar a grabar, perder el móvil poco después y comprobar que al menos parte de la evidencia ha sobrevivido fuera del dispositivo.

## Aclaración

El MVP incluye:

* export básico de evidencia (reconstrucción desde chunks)

No incluye:

* exportación legal avanzada
* herramientas forenses externas
* validación jurídica
