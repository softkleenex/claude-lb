import { InputOTP, InputOTPGroup, InputOTPSeparator, InputOTPSlot } from "@/components/ui/input-otp";

import type { ComponentProps } from "react";

export type TotpCodeInputProps = Omit<
  ComponentProps<typeof InputOTP>,
  "maxLength" | "render" | "children" | "value" | "onChange" | "onComplete"
> & {
  value: string;
  onChange: (value: string) => void;
  onComplete?: () => void;
  autoFocus?: boolean;
  disabled?: boolean;
};

/**
 * Six-digit authenticator code input (3 + 3 slots). Extra props (id, aria-*) are
 * forwarded so a wrapping `FormControl` can label it.
 */
export function TotpCodeInput({ value, onChange, onComplete, autoFocus, disabled, ...rest }: TotpCodeInputProps) {
  return (
    <InputOTP
      {...rest}
      maxLength={6}
      inputMode="numeric"
      pattern="^[0-9]*$"
      autoFocus={autoFocus}
      disabled={disabled}
      value={value}
      onChange={onChange}
      onComplete={onComplete}
    >
      <InputOTPGroup>
        <InputOTPSlot index={0} />
        <InputOTPSlot index={1} />
        <InputOTPSlot index={2} />
      </InputOTPGroup>
      <InputOTPSeparator />
      <InputOTPGroup>
        <InputOTPSlot index={3} />
        <InputOTPSlot index={4} />
        <InputOTPSlot index={5} />
      </InputOTPGroup>
    </InputOTP>
  );
}
