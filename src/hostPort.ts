/**
 * Splits an "address" string that may carry a trailing ":port" (e.g. "192.168.1.50:8443")
 * into separate host/port parts, so config UI can offer a single combined address field
 * while the rest of the code keeps working with plain host/port values.
 *
 * Only a plain trailing ":<digits>" is treated as a port; anything else (including bare
 * IPv6 addresses, which aren't expected here) is returned as the host unchanged.
 */
export function splitHostPort(address: string): { host: string; port: number | undefined } {
  const match = /^(.+):(\d+)$/.exec(address.trim());
  if (!match) {
    return { host: address.trim(), port: undefined };
  }
  return { host: match[1], port: Number(match[2]) };
}
