/** Queue-independent progress/correlation port used by document application services. */
export interface ProcessingJob {
  id?: string;
  updateProgress(value: number): Promise<unknown>;
}
