/**
 * E1-S — qué proyecto Supabase puede alcanzar cada entorno declarado.
 *
 * ## El hueco que cierra
 *
 * `EXPO_PUBLIC_GC_ENV` declara el entorno y `EXPO_PUBLIC_SUPABASE_URL`
 * decide el proyecto, y hasta ahora NADA ataba lo uno a lo otro: un build
 * que se declaraba `bench` podía apuntar a producción, y uno de
 * producción al proyecto desechable. `deriveProjectRef` ya calculaba qué
 * proyecto se alcanza de verdad, pero sólo lo IMPRIMÍA. Un log no es una
 * puerta.
 *
 * Aquí la relación pasa a ser 1:1 y de fallo cerrado: cada entorno tiene
 * UN proyecto autorizado, y cualquier otro —incluido «ninguno»— se
 * rechaza.
 *
 * ## Por qué esto no puede romper la subida
 *
 * `SECURITY.md` cede ante la subida: una guarda de seguridad no puede
 * dejar evidencia varada. Ésta no puede, y la razón es estructural, no
 * una promesa: Metro inlinea estos valores en tiempo de build, así que
 * para un APK dado la comprobación da siempre el mismo resultado. No
 * depende de la red, no depende del estado del dispositivo y no puede
 * cambiar en mitad de una sesión. Sólo puede impedir arrancar a un
 * binario mal construido; jamás puede detener a uno bien construido que
 * ya tiene evidencia en la cola.
 *
 * ## Por qué un ref puede estar versionado
 *
 * El project ref es la primera etiqueta de `<ref>.supabase.co`: viaja ya
 * dentro de cada APK publicado y en cada petición que el cliente hace.
 * No es un secreto. La clave anónima y el service role NO están aquí ni
 * pueden estarlo.
 *
 * ## Ausencia NO es permiso
 *
 * Un entorno cuyo proyecto autorizado todavía no está declarado se
 * rechaza, no se abre. Es la misma regla que el resto del sistema aplica
 * a la metadata de evidencia: ausencia significa «no declarado», nunca un
 * valor por defecto.
 */

import type { GcEnvironment } from './env';

/**
 * El proyecto autorizado de cada entorno.
 *
 * `null` significa **no declarado todavía**, y por tanto ningún proyecto
 * sirve: un build de ese entorno no arranca. No es una puerta abierta.
 */
export const EXPECTED_PROJECT_REFS: Readonly<
  Record<GcEnvironment, string | null>
> = Object.freeze({
  /** Proyecto de producción. */
  production: 'nahksdkcvhveoctpjrea',
  /** Proyecto desechable de banco (`guaria-auth-test`). */
  bench: 'rgbsofvycynhabycetel',
});

export type ProjectRefRefusal =
  /** La URL no tiene forma de proyecto Supabase, o no tiene host. */
  | 'no_project_ref'
  /** El entorno declarado todavía no tiene proyecto autorizado. */
  | 'env_has_no_declared_project'
  /** Hay proyecto autorizado, y el alcanzado no es ése. */
  | 'project_mismatch';

export type ProjectRefVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly refusal: ProjectRefRefusal };

/**
 * ¿Corresponde el proyecto alcanzado al entorno declarado?
 *
 * La tabla se pasa SIEMPRE de forma explícita, sin valor por defecto: el
 * único seam para sustituirla es el import, es decir las pruebas. No
 * existe ninguna vía para relajar esta comprobación desde la
 * configuración de un build — si existiera, sería justo el agujero que
 * esto cierra.
 *
 * Función pura: ni lee entorno, ni registra nada, ni lanza. Quien decide
 * qué hacer con el veredicto es `env.ts`.
 */
export function verifyProjectRef(
  gcEnv: GcEnvironment,
  projectRef: string | null,
  expected: Readonly<Record<GcEnvironment, string | null>>,
): ProjectRefVerdict {
  if (!projectRef) return { ok: false, refusal: 'no_project_ref' };

  const authorized = expected[gcEnv] ?? null;
  if (authorized === null) {
    return { ok: false, refusal: 'env_has_no_declared_project' };
  }
  if (projectRef !== authorized) {
    return { ok: false, refusal: 'project_mismatch' };
  }
  return { ok: true };
}
