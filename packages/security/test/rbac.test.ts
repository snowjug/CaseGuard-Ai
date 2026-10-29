import { describe, expect, it } from 'vitest';
import { PERMISSIONS, ROLES, type Permission, type Role } from '@caseguard/schemas';
import { AuthorizationError } from '../src/errors';
import {
  ROLE_PERMISSIONS,
  hasPermission,
  permissionsFor,
  requireDistinctApprover,
  requirePermission,
} from '../src/rbac';

/** Independent copy of the reviewed matrix: any change to ROLE_PERMISSIONS must be a deliberate edit here too. */
const REVIEWED_MATRIX: Record<Role, readonly Permission[]> = {
  engineer: [
    'case:read',
    'case:ingest',
    'case:analyze',
    'counterfactual:run',
    'skill:read',
    'skill:apply',
    'skill:extract',
    'warning:dismiss',
    'quality:read',
    'telemetry:read',
  ],
  reviewer: [
    'case:read',
    'skill:read',
    'quality:read',
    'telemetry:read',
    'evidence:review',
    'fork:review',
    'counterfactual:review',
    'quality:review',
    'actionvalue:override',
    'skill:review',
    'skill:validate',
    'audit:read',
  ],
  manager: ['case:read', 'quality:read', 'analytics:read', 'telemetry:read', 'skill:read'],
  skill_curator: [
    'case:read',
    'skill:read',
    'skill:extract',
    'skill:mutate',
    'skill:validate',
    'skill:review',
    'skill:approve',
    'skill:publish',
    'skill:retire',
    'skill:rollback',
    'skill:apply',
  ],
  administrator: PERMISSIONS,
};

const holders = (permission: Permission): Role[] =>
  ROLES.filter((role) => ROLE_PERMISSIONS[role].includes(permission));

describe('ROLE_PERMISSIONS', () => {
  it('[NFR-SEC-02] defines every role and only valid, unique permissions', () => {
    expect(Object.keys(ROLE_PERMISSIONS).sort()).toEqual([...ROLES].sort());
    for (const role of ROLES) {
      const granted = ROLE_PERMISSIONS[role];
      expect(new Set(granted).size, `${role} has duplicates`).toBe(granted.length);
      for (const permission of granted) expect(PERMISSIONS).toContain(permission);
    }
  });

  it.each(ROLES)('[NFR-SEC-02] %s matches the reviewed matrix exactly', (role) => {
    expect([...ROLE_PERMISSIONS[role]].sort()).toEqual([...REVIEWED_MATRIX[role]].sort());
  });

  it('[NFR-SEC-02] grants every permission to the administrator', () => {
    for (const permission of PERMISSIONS) {
      expect(ROLE_PERMISSIONS.administrator, permission).toContain(permission);
    }
  });

  it('[NFR-SEC-02] reserves governance, role management, deletion, demo control and export for administrators', () => {
    const adminOnly: Permission[] = [
      'governance:read',
      'governance:write',
      'roles:manage',
      'case:delete',
      'demo:manage',
      'export:data',
    ];
    for (const permission of adminOnly)
      expect(holders(permission), permission).toEqual(['administrator']);
  });

  it('[NFR-SEC-02] engineers cannot review, validate, approve, publish or administer', () => {
    const engineer = ROLE_PERMISSIONS.engineer;
    expect(engineer.filter((p) => p.endsWith(':review'))).toEqual([]);
    const forbidden: Permission[] = [
      'skill:review',
      'skill:validate',
      'skill:approve',
      'skill:publish',
      'skill:retire',
      'skill:rollback',
      'skill:mutate',
      'actionvalue:override',
      'audit:read',
      'case:delete',
      'governance:write',
    ];
    for (const permission of forbidden) expect(engineer, permission).not.toContain(permission);
  });

  it('[NFR-SEC-02] managers are read-only', () => {
    for (const permission of ROLE_PERMISSIONS.manager)
      expect(permission.endsWith(':read')).toBe(true);
    for (const permission of PERMISSIONS.filter((p) => !p.endsWith(':read'))) {
      expect(ROLE_PERMISSIONS.manager, permission).not.toContain(permission);
    }
  });

  it('[NFR-SEC-02] reviewers review but never ingest, analyze, run or publish', () => {
    const forbidden: Permission[] = [
      'case:ingest',
      'case:analyze',
      'counterfactual:run',
      'skill:extract',
      'skill:approve',
      'skill:publish',
      'case:delete',
    ];
    for (const permission of forbidden)
      expect(ROLE_PERMISSIONS.reviewer, permission).not.toContain(permission);
    expect(ROLE_PERMISSIONS.reviewer).toContain('evidence:review');
    expect(ROLE_PERMISSIONS.reviewer).toContain('audit:read');
  });

  it('[NFR-SEC-02] curators manage the whole skill lifecycle but nothing outside skills and case reading', () => {
    for (const permission of ROLE_PERMISSIONS.skill_curator) {
      expect(permission.startsWith('skill:') || permission === 'case:read', permission).toBe(true);
    }
    for (const permission of PERMISSIONS.filter((p) => p.startsWith('skill:'))) {
      expect(ROLE_PERMISSIONS.skill_curator, permission).toContain(permission);
    }
  });

  it('is deeply frozen so it cannot be widened at runtime', () => {
    expect(Object.isFrozen(ROLE_PERMISSIONS)).toBe(true);
    for (const role of ROLES) expect(Object.isFrozen(ROLE_PERMISSIONS[role])).toBe(true);
    expect(() => (ROLE_PERMISSIONS.engineer as Permission[]).push('case:delete')).toThrow(
      TypeError,
    );
  });
});

describe('permissionsFor / hasPermission', () => {
  it('returns the union in canonical order without duplicates', () => {
    const merged = permissionsFor(['engineer', 'reviewer']);
    expect(new Set(merged).size).toBe(merged.length);
    expect(merged).toEqual(PERMISSIONS.filter((p) => merged.includes(p)));
    expect(merged).toContain('case:ingest');
    expect(merged).toContain('evidence:review');
  });

  it('[NFR-SEC-02] denies by default for no roles and for unknown role strings', () => {
    expect(permissionsFor([])).toEqual([]);
    expect(permissionsFor(['root' as Role, '__proto__' as Role, 'constructor' as Role])).toEqual(
      [],
    );
    expect(hasPermission([], 'case:read')).toBe(false);
    expect(hasPermission(['toString' as Role], 'case:read')).toBe(false);
  });

  it('checks any held role', () => {
    expect(hasPermission(['manager', 'skill_curator'], 'skill:publish')).toBe(true);
    expect(hasPermission(['manager'], 'skill:publish')).toBe(false);
  });
});

describe('requirePermission', () => {
  const engineerContext = { permissions: permissionsFor(['engineer']) };

  it('passes silently when the permission is held', () => {
    expect(() => requirePermission(engineerContext, 'case:ingest')).not.toThrow();
  });

  it('[NFR-SEC-02] throws a 403 AuthorizationError otherwise', () => {
    try {
      requirePermission(engineerContext, 'skill:publish');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(AuthorizationError);
      const authz = error as AuthorizationError;
      expect(authz.status).toBe(403);
      expect(authz.code).toBe('forbidden');
      expect(authz.requiredPermission).toBe('skill:publish');
    }
  });

  it('denies a permission string that does not exist', () => {
    expect(() =>
      requirePermission({ permissions: ['case:read'] }, 'case:everything' as Permission),
    ).toThrow(AuthorizationError);
  });
});

describe('requireDistinctApprover', () => {
  it('[NFR-SEC-02] rejects self-approval and missing identities', () => {
    expect(() => requireDistinctApprover('user_a', 'user_a')).toThrow(AuthorizationError);
    expect(() => requireDistinctApprover('', 'user_b')).toThrow(AuthorizationError);
    expect(() => requireDistinctApprover('user_a', '')).toThrow(AuthorizationError);
  });

  it('accepts a different approver', () => {
    expect(() => requireDistinctApprover('user_a', 'user_b')).not.toThrow();
  });
});
