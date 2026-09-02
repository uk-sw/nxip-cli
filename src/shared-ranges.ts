import { parseIpv4Cidr, type Ipv4Range } from './cidr.js';

export interface SharedRange {
  cidr: string;
  range: Ipv4Range;
  why: string;
}

/**
 * Ranges that are *expected* to be reused across VPCs, and where an overlap
 * is a design decision rather than a problem.
 *
 * This exists because the alternative is unusable. AWS's own EKS guidance
 * recommends carving pod subnets out of 100.64.0.0/10 specifically so they
 * do not consume corporate RFC1918 space, which means a fleet of clusters is
 * *supposed* to reuse the same block in every VPC. Reporting each of those
 * as a collision buries the handful of real ones under hundreds of false
 * positives, and a tool that cries wolf on its first run does not get a
 * second.
 *
 * RFC1918 is deliberately absent. Two VPCs both claiming 10.0.0.0/16 is the
 * exact problem this scan exists to find.
 */
const DEFAULT_SHARED: { cidr: string; why: string }[] = [
  {
    cidr: '100.64.0.0/10',
    why: 'RFC 6598 shared address space, which AWS recommends for EKS pod subnets',
  },
  {
    cidr: '198.19.0.0/16',
    why: 'RFC 2544 benchmarking range, also used for non-routable secondary CIDRs',
  },
  {
    cidr: '169.254.0.0/16',
    why: 'RFC 3927 link-local, never routable between networks',
  },
];

export const DEFAULT_SHARED_RANGES: SharedRange[] = DEFAULT_SHARED.map((entry) => ({
  cidr: entry.cidr,
  why: entry.why,
  // Every default is a literal written above, so parsing cannot fail. The
  // non-null assertion is safe in a way a user-supplied range is not.
  range: parseIpv4Cidr(entry.cidr)!,
}));

export class SharedRangeError extends Error {}

/** Parses user-supplied --exclude values, rejecting anything unreadable. */
export function parseSharedRanges(cidrs: string[]): SharedRange[] {
  return cidrs.map((cidr) => {
    const range = parseIpv4Cidr(cidr);
    if (!range) {
      throw new SharedRangeError(`--exclude got "${cidr}", which is not a valid IPv4 CIDR.`);
    }
    return { cidr: range.cidr, range, why: 'excluded on the command line' };
  });
}

/**
 * True when an overlapping region is entirely inside a range that is
 * expected to be shared. Tested against the *shared portion* rather than
 * either block, so a VPC whose primary CIDR is routable but which also
 * carries a 100.64 secondary still gets its routable collisions reported.
 */
export function isExpectedlyShared(
  sharedStart: number,
  sharedEnd: number,
  sharedRanges: SharedRange[]
): SharedRange | null {
  for (const shared of sharedRanges) {
    if (sharedStart >= shared.range.start && sharedEnd <= shared.range.end) return shared;
  }
  return null;
}
