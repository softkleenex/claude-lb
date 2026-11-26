import { describe, expect, it } from "vitest";

import {
  AuthStatusSchema,
  PasswordChangeFormSchema,
  PasswordSetupFormSchema,
  TotpCodeSchema,
} from "@/features/auth/schemas";

describe("auth schemas", () => {
  it("defaults authEnabled for servers that predate the field", () => {
    expect(
      AuthStatusSchema.parse({ configured: true, totpEnabled: false, authenticated: true }),
    ).toEqual({
      configured: true,
      totpEnabled: false,
      authenticated: true,
      reason: "",
      role: "admin",
      guestAccessEnabled: false,
      guestPasswordRequired: false,
      authEnabled: true,
    });
  });

  it("requires matching passwords of at least 8 characters on setup", () => {
    expect(
      PasswordSetupFormSchema.safeParse({ password: "short", confirmPassword: "short" }).error?.issues[0]?.message,
    ).toBe("settings.password.validation.minLength");
    expect(
      PasswordSetupFormSchema.safeParse({ password: "long-enough", confirmPassword: "different" }).error?.issues[0]
        ?.message,
    ).toBe("settings.password.validation.mismatch");
    expect(PasswordSetupFormSchema.safeParse({ password: "long-enough", confirmPassword: "long-enough" }).success).toBe(
      true,
    );
  });

  it("requires the current password on change", () => {
    const result = PasswordChangeFormSchema.safeParse({
      currentPassword: "",
      newPassword: "long-enough",
      confirmPassword: "long-enough",
    });
    expect(result.error?.issues[0]?.message).toBe("settings.password.validation.required");
  });

  it("accepts only six digits as a TOTP code", () => {
    expect(TotpCodeSchema.safeParse({ code: "123456" }).success).toBe(true);
    expect(TotpCodeSchema.safeParse({ code: "12345" }).success).toBe(false);
    expect(TotpCodeSchema.safeParse({ code: "12345a" }).success).toBe(false);
  });
});
