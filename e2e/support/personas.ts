export type PersonaKey = 'engineer' | 'reviewer' | 'manager' | 'curator' | 'admin' | 'otherTenant';
export type RoleKey = 'engineer' | 'reviewer' | 'manager' | 'skill_curator' | 'administrator';

/** The labels of `ROLE_LABELS` in `@caseguard/schemas` (the header menu shows them). Kept as text: the suite is black box. */
export const ROLE_LABELS: Readonly<Record<RoleKey, string>> = {
  engineer: 'Technical Support Engineer',
  reviewer: 'Support Quality Reviewer',
  manager: 'Support Manager',
  skill_curator: 'Knowledge / Skill Curator',
  administrator: 'Administrator',
};

export interface PersonaInfo {
  readonly key: PersonaKey;
  /** The id sent as `x-cg-persona` and stored by the web app. */
  readonly id: string;
  /** The name the persona picker and the header menu show. */
  readonly displayName: string;
  readonly role: RoleKey;
  readonly roleLabel: string;
  readonly tenantId: string;
}

export const CONTOSO = 'tenant_contoso_support';
export const FABRIKAM = 'tenant_fabrikam_lab';

const persona = (
  key: PersonaKey,
  id: string,
  displayName: string,
  role: RoleKey,
  tenantId: string,
): PersonaInfo => ({ key, id, displayName, role, roleLabel: ROLE_LABELS[role], tenantId });

/** The synthetic personas of the local profile (`GET /api/v1/dev/personas`). Nothing here is a real person. */
export const PERSONAS: Readonly<Record<PersonaKey, PersonaInfo>> = {
  engineer: persona(
    'engineer',
    'user_ava_engineer',
    'Ava Engineer (synthetic)',
    'engineer',
    CONTOSO,
  ),
  reviewer: persona(
    'reviewer',
    'user_riley_reviewer',
    'Riley Reviewer (synthetic)',
    'reviewer',
    CONTOSO,
  ),
  manager: persona(
    'manager',
    'user_morgan_manager',
    'Morgan Manager (synthetic)',
    'manager',
    CONTOSO,
  ),
  curator: persona(
    'curator',
    'user_casey_curator',
    'Casey Curator (synthetic)',
    'skill_curator',
    CONTOSO,
  ),
  admin: persona('admin', 'user_alex_admin', 'Alex Admin (synthetic)', 'administrator', CONTOSO),
  otherTenant: persona(
    'otherTenant',
    'user_fabi_engineer',
    'Fabi Engineer (synthetic)',
    'engineer',
    FABRIKAM,
  ),
};

export const PERSONA_KEYS = Object.keys(PERSONAS) as PersonaKey[];

/** The name without the `(synthetic)` suffix the picker shows in headings. */
export const shortName = (info: PersonaInfo): string =>
  info.displayName.replace(/\s*\(synthetic\)\s*$/i, '');
