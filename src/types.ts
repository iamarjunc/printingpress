export interface PrintingRecord {
  id: string;
  customer_name: string;
  bill_type: string;
  start_no: number;
  end_no: number;
  pages: number;
  books: number;
  added_by: string;
  created_at: string;
  updated_at: string | null;
  date_key: string;
  photo_path: string | null;
  is_legacy: boolean;
}

export interface StoredRecord {
  record: PrintingRecord;
  path: string;
  sha: string;
}

export interface GitHubConfig {
  owner: string;
  repo: string;
  branch: string;
  token: string;
}

export interface LoadResult {
  records: StoredRecord[];
  issues: string[];
  headSha: string;
}
