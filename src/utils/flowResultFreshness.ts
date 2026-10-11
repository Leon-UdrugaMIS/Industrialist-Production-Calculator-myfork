export function areFlowResultVersionsCurrent(
  resultGraphVersion: number,
  resultDataDbVersion: number,
  currentGraphVersion: number,
  currentDataDbVersion: number,
): boolean {
  return resultGraphVersion === currentGraphVersion && resultDataDbVersion === currentDataDbVersion;
}
