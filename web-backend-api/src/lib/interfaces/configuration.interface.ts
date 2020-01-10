import { IPostToOtherMethod } from './interceptor.interface';

/**
 * Interface for BackendService configuration options
 */
export abstract class BackendConfigArgs {
  /**
   * The base path to the api, e.g, 'api/'.
   * If not specified than `parseRequestUrl` assumes it is the first path segment in the request.
   */
  apiBase?: string;
  /**
   * false (default) if search match should be case insensitive
   */
  caseSensitiveSearch?: boolean;
  /**
   * false (default) put content directly inside the response body.
   * true: encapsulate content in a `data` property inside the response body, `{ data: ... }`.
   */
  dataEncapsulation?: boolean;
  /**
   * 'autoincrement' (default) strategy for generate ids for items in collections
   */
  strategyId?: 'uuid'|'autoincrement'|'provided';
  /**
   * true (default) assign attributes values in body preserving original item;
   * false replace item in body in collection
   */
  appendPut?: boolean;
  /**
   * true (default) assign attributes values in body preserving original item;
   * false replace item in body in collection
   */
  appendExistingPost?: boolean;
  /**
   * delay (in ms) to simulate latency
   */
  delay?: number;
  /**
   * false (default) should 204 when object-to-delete not found; true: 404
   */
  delete404?: boolean;
  /**
   * host for this service, e.g., 'localhost'
   */
  host?: string;
  /**
   * false (default) should pass unrecognized request URL through to original backend; true: 404
   */
  passThruUnknownUrl?: boolean;
  /**
   * true (default) should NOT return the item (204) after a POST. false: return the item (200).
   */
  post204?: boolean;
  /**
   * false (default) should NOT update existing item with POST. false: OK to update.
   */
  post409?: boolean;
  /**
   * true (default) should NOT return the item (204) after a POST. false: return the item (200).
   */
  put204?: boolean;
  /**
   * false (default) if item not found, create as new item; false: should 404.
   */
  put404?: boolean;
  /**
   * root path _before_ any API call, e.g., ''
   */
  rootPath?: string;
  /**
   * [] (default) POST method mappings for other methods
   */
  postsToOtherMethod?: IPostToOtherMethod[];
}

/**
 * Interface for InMemoryBackend configuration options
 */
export abstract class BackendTypeArgs {
  dbtype?: 'memory' | 'indexdb';
  databaseName?: string;
}