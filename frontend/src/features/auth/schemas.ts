import { z } from "zod";

// Mirrors `claude_lb.modules.auth.service.MIN_PASSWORD_LENGTH`.
export const MIN_DASHBOARD_PASSWORD_LENGTH = 8;

const PASSWORD_REQUIRED_MESSAGE = "settings.password.validation.required";

const dashboardPasswordSchema = z.string().min(MIN_DASHBOARD_PASSWORD_LENGTH, {
  message: "settings.password.validation.minLength",
});

// Guest access arrives in Step G; until then every signed-in user is an admin.
export const DashboardRoleSchema = z.enum(["admin", "guest"]);
export const DashboardPermissionSchema = z.enum(["read", "write"]);

/** `GET /api/auth/status` (also returned by login and password set). */
export const AuthStatusSchema = z.object({
  configured: z.boolean(),
  totpEnabled: z.boolean(),
  authenticated: z.boolean(),
  reason: z.string().default(""),
  authEnabled: z.boolean().default(true),
});

export const LoginRequestSchema = z.object({
  password: z.string().min(1, { message: PASSWORD_REQUIRED_MESSAGE }),
  totpCode: z.string().optional(),
});

export const PasswordSetupFormSchema = z
  .object({
    password: dashboardPasswordSchema,
    confirmPassword: z.string(),
    bootstrapToken: z.string().optional(),
  })
  .refine((values) => values.password === values.confirmPassword, {
    message: "settings.password.validation.mismatch",
    path: ["confirmPassword"],
  });

export const PasswordChangeFormSchema = z
  .object({
    currentPassword: z.string().min(1, { message: PASSWORD_REQUIRED_MESSAGE }),
    newPassword: dashboardPasswordSchema,
    confirmPassword: z.string(),
  })
  .refine((values) => values.newPassword === values.confirmPassword, {
    message: "settings.password.validation.mismatch",
    path: ["confirmPassword"],
  });

/** `POST /api/auth/password` body. `currentPassword` is required once a password exists. */
export type SetPasswordRequest = {
  password: string;
  currentPassword?: string;
};

export const TotpCodeSchema = z.object({
  code: z.string().regex(/^\d{6}$/, "settings.totp.validation.codeLength"),
});

/** `POST /api/auth/totp/enroll`. */
export const TotpEnrollmentSchema = z.object({
  secret: z.string(),
  provisioningUri: z.string(),
});

export type AuthStatus = z.infer<typeof AuthStatusSchema>;
export type DashboardRole = z.infer<typeof DashboardRoleSchema>;
export type DashboardPermission = z.infer<typeof DashboardPermissionSchema>;
export type LoginRequest = z.infer<typeof LoginRequestSchema>;
export type PasswordSetupForm = z.infer<typeof PasswordSetupFormSchema>;
export type PasswordChangeForm = z.infer<typeof PasswordChangeFormSchema>;
export type TotpEnrollment = z.infer<typeof TotpEnrollmentSchema>;

export function getFirstZodIssueMessage(error: unknown): string | null {
  if (!(error instanceof z.ZodError)) {
    return null;
  }

  const [firstIssue] = error.issues;
  return typeof firstIssue?.message === "string" ? firstIssue.message : null;
}
