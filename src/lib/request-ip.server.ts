import { getRequestIP } from "@tanstack/react-start/server";

export function clientIp(): string {
  try {
    return getRequestIP({ xForwardedFor: true }) || "unknown";
  } catch {
    return "unknown";
  }
}
