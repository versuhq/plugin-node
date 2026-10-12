export interface LockfileUpdater {
  update(directory: string): Promise<void>;
}
