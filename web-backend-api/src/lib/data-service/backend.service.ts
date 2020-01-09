import { BehaviorSubject, Observable, throwError } from 'rxjs';
import { concatMap, first } from 'rxjs/operators';
import { LoadFn, TransformGetFn, TransformPostFn, TransformPutFn, IBackendUtils } from '../interfaces/backend.interface';
import { BackendConfigArgs } from '../interfaces/configuration.interface';
// tslint:disable-next-line: max-line-length
import { IErrorMessage, IHttpErrorResponse, IHttpResponse, IInterceptorUtils, IPassThruBackend, IRequestInfo, IRequestInterceptor, IRequestCore, IPostToOtherMethod } from '../interfaces/interceptor.interface';
// tslint:disable-next-line: max-line-length
import { FilterFn, FilterOp, IQueryCursor, IQueryFilter, IQueryParams, IQueryResult, IQuickFilter } from '../interfaces/query.interface';
import { IParsedRequestUrl, IUriInfo } from '../interfaces/url.interface';
import { delayResponse } from '../utils/delay-response';
import { STATUS } from '../utils/http-status-codes';
import { parseUri } from '../utils/parse-uri';

interface IInterceptorInfo {
  interceptor?: IRequestInterceptor;
  interceptorIds?: string[];
}

export function clone(data: any) {
  return JSON.parse(JSON.stringify(data));
}

export function removeTrailingSlash(path: string) {
  return path.replace(/\/$/, '');
}

export function paramParser(rawParams: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  if (rawParams.length > 0) {
    const params: string[] = rawParams.split('&');
    params.forEach((param: string) => {
      const eqIdx = param.indexOf('=');
      const [key, val]: string[] = eqIdx === -1 ?
        [decodeURI(param), ''] :
        [decodeURI(param.slice(0, eqIdx)), decodeURI(param.slice(eqIdx + 1))];
      const list = map.get(key) || [];
      list.push(val);
      map.set(key, list);
    });
  }
  return map;
}

export abstract class BackendService {

  protected loadsFn: Array<LoadFn> = [];
  protected replaceMap: Map<string, string[]> = new Map();
  protected postToOtherMethodMap: Map<string, IPostToOtherMethod[]> = new Map();
  protected transformGetAllMap: Map<string, TransformGetFn> = new Map();
  protected transformGetByIdMap: Map<string, TransformGetFn> = new Map();
  protected transformPostMap: Map<string, TransformPostFn> = new Map();
  protected transformPutMap: Map<string, TransformPutFn> = new Map();
  protected fieldsFilterMap: Map<string, Map<string, FilterFn | FilterOp>> = new Map();
  protected quickFilterMap: Map<string, IQuickFilter> = new Map();

  private requestInterceptors: Array<IRequestInterceptor> = [];

  protected dbReadySubject: BehaviorSubject<boolean>;
  private passThruBackend: IPassThruBackend;
  protected config: BackendConfigArgs = {};

  protected utils: IBackendUtils;

  constructor(
    config: BackendConfigArgs = {}
  ) {
    const loc = this.getLocation('/');
    this.config.host = loc.host;     // default to app web server host
    this.config.rootPath = loc.path; // default to path when app is served (e.g.'/')
    for (const prop in config) {
      if (config[prop]) {
        this.config[prop] = config[prop];
      }
    }
    this.dbReadySubject = new BehaviorSubject(false);
  }

  backendUtils(value: IBackendUtils): void {
    this.utils = value;
  }

  addTransformGetAllMap(collectionName: string, transformfn: TransformGetFn) {
    this.transformGetAllMap.set(collectionName, transformfn);
  }

  addTransformGetByIdMap(collectionName: string, transformfn: TransformGetFn) {
    this.transformGetByIdMap.set(collectionName, transformfn);
  }

  addTransformPostMap(collectionName: string, transformfn: TransformPostFn) {
    this.transformPostMap.set(collectionName, transformfn);
  }

  addTransformPutMap(collectionName: string, transformfn: TransformPutFn) {
    this.transformPutMap.set(collectionName, transformfn);
  }

  addQuickFilterMap(collectionName: string, quickFilter: IQuickFilter) {
    this.quickFilterMap.set(collectionName, quickFilter);
  }

  addFieldFilterMap(collectionName: string, field: string, filterfn: FilterFn | FilterOp) {
    let fieldsFilterMap = this.fieldsFilterMap.get(collectionName);
    if (fieldsFilterMap !== undefined) {
      fieldsFilterMap.set(field, filterfn);
    } else {
      fieldsFilterMap = new Map();
      fieldsFilterMap.set(field, filterfn);
      this.fieldsFilterMap.set(collectionName, fieldsFilterMap);
    }
  }

  addReplaceUrl(collectionName: string, replace: string | string[]) {
    if (typeof replace === 'string') {
      const replaces = replace.split('/').filter(value => value.trim().length > 0);
      this.replaceMap.set(collectionName, replaces);
    } else {
      this.replaceMap.set(collectionName, replace);
    }
  }

  addPostToOtherMethodMap(collectionName: string, postToOtherMethod: IPostToOtherMethod) {
    let postsToOtherMethod = this.postToOtherMethodMap.get(collectionName);
    if (postsToOtherMethod !== undefined) {
      postsToOtherMethod.push(postToOtherMethod);
    } else {
      postsToOtherMethod = new Array<IPostToOtherMethod>();
      postsToOtherMethod.push(postToOtherMethod);
      this.postToOtherMethodMap.set(collectionName, postsToOtherMethod);
    }
  }

  addRequestInterceptor(requestInterceptor: IRequestInterceptor) {
    if (!requestInterceptor.method) {
      requestInterceptor['method'] = 'GET';
    }
    if (!requestInterceptor.applyToPath) {
      requestInterceptor['applyToPath'] = 'complete';
    }
    if (requestInterceptor.applyToPath !== 'complete' && !requestInterceptor.collectionName) {
      throw new Error('For no complete interceptor paths, must be informed collectionName in interceptor.');
    }
    if (requestInterceptor.query) {
      let params: Map<string, string[]>;
      const query = requestInterceptor.query;
      if (typeof query === 'string') {
        params = paramParser(query);
      } else if (query instanceof Map) {
        params = new Map(clone(Array.from(query)));
      } else {
        params = new Map(clone(Array.from(Object.keys(query).map(key => [key, query[key]]))));
      }
      if (params && params.keys.length > 0) {
        requestInterceptor['query'] = params;
      }
    }

    this.requestInterceptors.push(requestInterceptor);
  }

  addRequestInterceptorByValue(value: any): void {
    let obj: any;
    let response: IHttpResponse<any> | IHttpErrorResponse;
    if (typeof value === 'string') {
      try {
        obj = JSON.parse(value);
      } catch (error) {
        const msg = 'O valor informado não é possível de ser interpretado como uma interface IRequestInterceptor;' +
          ` original error: ${error.message}`;
        throw new Error(msg);
      }
    } else {
      obj = value;
    }
    if (obj && obj.path && typeof obj.path === 'string' && obj.response) {
      const path = '/' + obj.path.replace(/^\//, '');
      const url = window.location.origin + path;
      const status = (obj.response.status && typeof obj.response.status === 'number') ? obj.response.status :
        (obj.response.statusCode && typeof obj.response.statusCode === 'number') ? obj.response.statusCode :
          (obj.response.error) ? 400 : 200;
      if (obj.response.error) {
        response = this.utils.createErrorResponseOptions(url, status, obj.response.error);
      } else {
        response = this.utils.createResponseOptions(url, status, (obj.response.body) ? obj.response.body : obj.response);
      }
    } else {
      throw new Error('O valor informado não é possível de ser interpretado como uma interface IRequestInterceptor');
    }

    const requestInterceptor: IRequestInterceptor = {
      method: obj.method ? obj.method : 'GET',
      path: obj.path,
      response,
      collectionName: obj.collectionName ? obj.collectionName : undefined,
      applyToPath: obj.applyToPath ? obj.applyToPath : 'complete'
    };
    if (requestInterceptor.applyToPath !== 'complete' && !requestInterceptor.collectionName) {
      throw new Error('For no complete interceptor paths, must be informed collectionName in interceptor.');
    }

    let params: Map<string, string[]>;
    const query = obj.query ? obj.query :
      (obj.queryStringParameters ? obj.queryStringParameters : undefined);
    if (query) {
      if (typeof query === 'string') {
        params = paramParser(query);
      } else {
        params = new Map(clone(Array.from(Object.keys(query).map(key => [key, query[key]]))));
      }
      if (params && params.keys.length > 0) {
        requestInterceptor['query'] = params;
      }
    }

    this.requestInterceptors.push(requestInterceptor);
  }

  private get dbReady(): Observable<boolean> {
    return this.dbReadySubject.asObservable().pipe(first((r: boolean) => r));
  }

  handleRequest(req: IRequestCore<any>): Observable<any> {
    //  handle the request when there is an in-memory database
    return this.dbReady.pipe(concatMap(() => this.handleRequest_(req)));
  }

  private handleRequest_(req: IRequestCore<any>): Observable<any> {

    const url = req.urlWithParams ? req.urlWithParams : req.url;
    let method = req.method || 'GET';

    const intInfo: IInterceptorInfo = {};

    const parsed: IParsedRequestUrl = this.parseRequestUrl(method, url, intInfo);
    let response$: Observable<any>;

    if (intInfo.interceptor && intInfo.interceptor.applyToPath === 'complete') {
      const intUtils = this.createInterceptorUtils(url, undefined, undefined, parsed.query, req.body);
      response$ = this.processInterceptResponse(intInfo.interceptor, intUtils);
      if (response$) {
        return response$;
      } else if (this.config.passThruUnknownUrl) {
        return this.getPassThruBackend().handle(req);
      } else {
        const error: IErrorMessage = {
          message: `Interceptor path '${intInfo.interceptor.path}' does not return a valid response.`,
          detailedMessage: 'Implement a valid response or configure service to dispatch to real backend. (config.passThruUnknownUrl)'
        };
        return throwError(this.utils.createErrorResponseOptions(url, STATUS.NOT_IMPLEMENTED, error));
      }
    }

    if (method.toUpperCase() === 'POST') {
      method = this.getPostToOtherMethod(parsed.collectionName, parsed.extras, parsed.query, req.body);
    }

    const reqInfo: IRequestInfo = {
      req,
      method,
      url,
      apiBase: parsed.apiBase,
      collectionName: parsed.collectionName,
      id: parsed.id,
      query: parsed.query,
      extras: parsed.extras,
      resourceUrl: parsed.resourceUrl,
      body: req.body,
      interceptor: intInfo.interceptor,
      interceptorIds: intInfo.interceptorIds
    };

    if (this.hasCollection(parsed.collectionName)) {
      return this.collectionHandler(reqInfo);
    } else if (this.config.passThruUnknownUrl) {
      // Caso não tenha a collection, repassa a requisição para o backend verdadeiro
      return this.getPassThruBackend().handle(req);
    } else {
      const error: IErrorMessage = {
        message: `Collection '${parsed.collectionName}' not found`,
        detailedMessage: 'Implement interceptor to complete path or configure ' +
          'service to dispatch to real backend. (config.passThruUnknownUrl)'
      };
      return throwError(this.utils.createErrorResponseOptions(url, STATUS.NOT_FOUND, error));
    }
  }

  abstract hasCollection(collectionName: string): boolean;

  private collectionHandler(reqInfo: IRequestInfo): Observable<any> {
    let response$: Observable<any>;
    switch (reqInfo.method.toLocaleLowerCase()) {
      case 'get':
        response$ = this.get(reqInfo);
        break;
      case 'post':
        response$ = this.post(reqInfo);
        break;
      case 'put':
        response$ = this.put(reqInfo);
        break;
      case 'delete':
        response$ = this.delete(reqInfo);
        break;
      default:
        const error: IErrorMessage = {
          message: `Method '${reqInfo.method.toUpperCase()}' not allowed`,
          detailedMessage: 'Only methods GET, POST, PUT and DELETE are allowed'
        };
        response$ = throwError(this.utils.createErrorResponseOptions(reqInfo.url, STATUS.METHOD_NOT_ALLOWED, error));
        break;
    }
    return response$;
  }

  abstract get$(
    collectionName: string, id: string, query: Map<string, string[]>, url: string, caseSensitiveSearch?: string
  ): Observable<any>;

  private get({ collectionName, id, query, url, interceptor, interceptorIds }: IRequestInfo): Observable<any> {
    let response$: Observable<any>;

    // Caso tenha um interceptador, retorna a resposta do mesmo
    if (interceptor) {
      const intUtils = this.createInterceptorUtils(url, id, interceptorIds, query);
      response$ = this.processInterceptResponse(interceptor, intUtils);
      if (response$) {
        return this.addDelay(response$, this.config.delay);
      }
    }

    response$ = this.get$(collectionName, id, query, url, this.config.caseSensitiveSearch ? undefined : 'i');
    return this.addDelay(response$, this.config.delay);
  }

  protected applyTransformGet(item: any, transformfn: TransformGetFn): Promise<any> {
    return new Promise<any>((resolve, reject) => {
      const retorno = transformfn.call(this, item, this);
      if (retorno instanceof Observable) {
        retorno.subscribe(itemObs => resolve(itemObs), error => reject(error));
      } else {
        resolve(retorno);
      }
    });
  }

  abstract post$(collectionName: string, id: string, item: any, url: string): Observable<any>;

  private post({ collectionName, id, body, url, interceptor, interceptorIds }: IRequestInfo): Observable<any> {
    let response$: Observable<any>;

    // Caso tenha um interceptador, retorna a resposta do mesmo
    if (interceptor) {
      const intUtils = this.createInterceptorUtils(url, id, interceptorIds, undefined, body);
      response$ = this.processInterceptResponse(interceptor, intUtils);
      if (response$) {
        return this.addDelay(response$, this.config.delay);
      }
    }

    response$ = this.post$(collectionName, id, body, url);
    return this.addDelay(response$, this.config.delay);
  }

  protected applyTransformPost(body: any, transformfn: TransformPostFn): Promise<any> {
    return new Promise<any>((resolve, reject) => {
      const retorno = transformfn.call(this, body, this);
      if (retorno instanceof Observable) {
        retorno.subscribe(item => resolve(item), error => reject(error));
      } else {
        resolve(retorno);
      }
    });
  }

  abstract put$(collectionName: string, id: string, item: any, url: string): Observable<any>;

  private put({ collectionName, id, body, url, interceptor, interceptorIds }: IRequestInfo): Observable<any> {
    let response$: Observable<any>;

    // Caso tenha um interceptador, retorna a resposta do mesmo
    if (interceptor) {
      const intUtils = this.createInterceptorUtils(url, id, interceptorIds, undefined, body);
      response$ = this.processInterceptResponse(interceptor, intUtils);
      if (response$) {
        return this.addDelay(response$, this.config.delay);
      }
    }

    response$ = this.put$(collectionName, id, body, url);
    return this.addDelay(response$, this.config.delay);
  }

  protected applyTransformPut(item: any, body: any, transformfn: TransformPutFn): Promise<any> {
    return new Promise<any>((resolve, reject) => {
      const retorno = transformfn.call(this, item, body, this);
      if (retorno instanceof Observable) {
        retorno.subscribe(itemObs => resolve(itemObs), error => reject(error));
      } else {
        resolve(retorno);
      }
    });
  }

  abstract delete$(collectionName: string, id: string, url: string): Observable<any>;

  private delete({ collectionName, id, url, interceptor, interceptorIds }: IRequestInfo): Observable<any> {
    let response$: Observable<any>;

    // Caso tenha um interceptador, retorna a resposta do mesmo
    if (interceptor) {
      const intUtils = this.createInterceptorUtils(url, id, interceptorIds);
      response$ = this.processInterceptResponse(interceptor, intUtils);
      if (response$) {
        return this.addDelay(response$, this.config.delay);
      }
    }

    response$ = this.delete$(collectionName, id, url);
    return this.addDelay(response$, this.config.delay);
  }

  protected bodify(data: any) {
    return this.config.dataEncapsulation ? { data } : data;
  }

  private addDelay(response$: Observable<{}>, delay: number): Observable<any> {
    return delay === 0 ? response$ : delayResponse(response$, (Math.floor((Math.random() * delay) + 1)) || 500);
  }

  private getFieldFilterMap(collectionName: string, field: string): FilterFn | FilterOp | undefined {
    const fieldsFilterMap = this.fieldsFilterMap.get(collectionName);
    if (fieldsFilterMap !== undefined) {
      return fieldsFilterMap.get(field);
    } else {
      return undefined;
    }
  }

  private filterItem(item: any, conditions: Array<IQueryFilter>, useFilterOr: boolean): boolean {
    if (conditions === undefined) {
      return true;
    }
    return useFilterOr ? this.filterItemOr(item, conditions) : this.filterItemAnd(item, conditions);
  }

  private filterItemAnd(item: any, conditions: Array<IQueryFilter>): boolean {
    let ok = true;
    let i = conditions.length;
    let cond: IQueryFilter;
    while (ok && i) {
      i -= 1;
      cond = conditions[i];
      if (cond.fn) {
        ok = cond.fn.call(this, item);
      } else {
        ok = cond.rx.test(item[cond.name]);
      }
    }
    return ok;
  }

  private filterItemOr(item: any, conditions: Array<IQueryFilter>): boolean {
    let okOr = false;
    let okAnd = true;
    let i = conditions.length;
    let cond: IQueryFilter;
    while (okAnd && i) {
      i -= 1;
      cond = conditions[i];
      if (cond.or) {
        if (!okOr) {
          if (cond.fn) {
            okOr = cond.fn.call(this, item);
          } else {
            okOr = cond.rx.test(item[cond.name]);
          }
        }
      } else {
        if (cond.fn) {
          okAnd = cond.fn.call(this, item);
        } else {
          okAnd = cond.rx.test(item[cond.name]);
        }
      }
    }
    return okOr && okAnd;
  }

  private createFilterFn(value: string|string[], filterFn: FilterFn): FilterFn {
    return (item: any) => {
      return filterFn.call(this, value, item);
    };
  }

  private createFilterOpFn(field: string, value: string, filterOp: FilterOp): FilterFn {
    return (item: any) => {
      switch (filterOp) {
        case 'eq':
          // tslint:disable-next-line: triple-equals
          return item[field] == value;
        case 'ne':
          // tslint:disable-next-line: triple-equals
          return item[field] != value;
        case 'gt':
          return item[field] > value;
        case 'ge':
          return item[field] >= value;
        case 'lt':
          return item[field] < value;
        case 'le':
          return item[field] <= value;
        default:
          return false;
      }
    };
  }

  private createFilterArrayFn(field: string, value: string[]): FilterFn {
    return (item: any) => {
      return value.includes(item[field]);
    };
  }

  protected getQueryParams(collectionName: string, query: Map<string, string[]>, caseSensitive: string): IQueryParams {
    const quickFilter = this.quickFilterMap.get(collectionName);
    const queryParams: IQueryParams = { count: 0 };
    query.forEach((value: string[], name: string) => {
      if (name === 'page') {
        queryParams['page'] = parseInt(value[0], 10);
      } else if (name === 'pageSize') {
        queryParams['pageSize'] = parseInt(value[0], 10);
      } else if (quickFilter && quickFilter.term === name && value[0]) {
        queryParams['useFilterOr'] = true;
        const fields = quickFilter.fields;
        if (fields !== undefined) {
          if (queryParams['conditions'] === undefined) {
            queryParams['conditions'] = [];
          }
          queryParams.conditions.push(...fields.map<IQueryFilter>((field) => {
            return { name: field, rx: new RegExp(value[0], caseSensitive), or: true };
          }));
        }
      } else if (name !== 'order' && name !== 'fields' && name !== '$filter') {
        if (queryParams['conditions'] === undefined) {
          queryParams['conditions'] = [];
        }
        const condition: IQueryFilter = { name, or: false };
        const filterFn = this.getFieldFilterMap(collectionName, name);
        if (filterFn !== undefined && typeof filterFn === 'function') {
          condition['fn'] = this.createFilterFn(value.length > 1 ? value : value[0], filterFn);
        } else if (filterFn !== undefined && typeof filterFn === 'string' && value.length === 1) {
          condition['fn'] = this.createFilterOpFn(name, value[0], filterFn);
        } else if (value.length > 1) {
          condition['fn'] = this.createFilterArrayFn(name, value);
        } else {
          condition['rx'] = new RegExp(value[0], caseSensitive);
        }
        queryParams.conditions.push(condition);
      }
    });
    return queryParams;
  }

  protected getAllItems(cursor: IQueryCursor, queryResults: IQueryResult, queryParams: IQueryParams, transformfn: TransformGetFn): boolean {
    let retorna = false;
    if (cursor) {
      const item = cursor.value;
      if (this.filterItem(item, queryParams.conditions, queryParams.useFilterOr)) {
        if (queryParams.page && queryParams.pageSize) {
          if (queryParams.count < ((queryParams.page - 1) * queryParams.pageSize)) {
            queryParams.count++;
            cursor.continue();
          } else if (queryParams.count < (queryParams.page * queryParams.pageSize)) {

            (async (itemAsync: any, transformGetFn: TransformGetFn) => {
              if (transformfn !== undefined) {
                itemAsync = await this.applyTransformGet(itemAsync, transformGetFn);
              }
              return itemAsync;
            })(item, transformfn).then(itemAsync => {
              queryResults.items.push(itemAsync);
              queryResults.hasNext = true;
              queryParams.count++;
              cursor.continue();
            });
          } else {
            retorna = true;
          }
        } else {

          (async (itemAsync: any, transformGetFn: TransformGetFn) => {
            if (transformfn !== undefined) {
              itemAsync = await this.applyTransformGet(itemAsync, transformGetFn);
            }
            return itemAsync;
          })(item, transformfn).then(itemAsync => {
            queryResults.items.push(itemAsync);
            queryResults.hasNext = true;
            cursor.continue();
          });
        }
      } else {
        cursor.continue();
      }
    } else {
      queryResults.hasNext = false;
      retorna = true;
    }
    return retorna;
  }

  private hasRequestInterceptor(
    applyToPath: string,
    method: string,
    collectionName: string,
    uriPaths: string[],
    uriQuery: Map<string, string[]>,
    intInfo: IInterceptorInfo
  ): boolean {
    const self = this;
    const interceptorIds: string[] = [];
    const interceptors = self.requestInterceptors.filter(value => {
      return value.applyToPath === applyToPath;
    });
    const interceptor = interceptors.find(value => {
      return self.compareRequestInterceptor(value, method, collectionName, uriPaths, uriQuery, interceptorIds);
    });
    if (interceptor) {
      intInfo['interceptor'] = interceptor;
      if (interceptorIds.length > 0) {
        intInfo['interceptorIds'] = interceptorIds;
      }
      return true;
    } else {
      return false;
    }
  }

  private compareRequestInterceptor(
    interceptor: IRequestInterceptor,
    method: string,
    collectionName: string,
    uriPaths: string[],
    uriQuery: Map<string, string[]>,
    interceptorIds?: string[]
  ): boolean {
    let interceptorPathOk = true;
    let interceptorQueryOk = true;

    if (interceptor.applyToPath !== 'complete' && interceptor.collectionName !== collectionName) {
      return false;
    }

    if (interceptor.method.toLowerCase() !== method.toLowerCase()) {
      return false;
    }

    const intPaths = removeTrailingSlash(interceptor.path).split('/');
    // Se possui o mesmo número de segmentos na URL
    interceptorPathOk = intPaths.length === uriPaths.length;
    if (interceptorPathOk) {
      // Avalia se todos os segmentos são iguais
      for (let i = 0; i < intPaths.length && interceptorPathOk; i++) {
        // Se é um segmento 'coriga' descarta o mesmo.
        // Utilizado para interceptar urls tipo: /api/parent/:id/child/:id/action
        if (intPaths[i] === '**') {
          continue;
        }
        if (interceptorIds && interceptorIds instanceof Array &&
          (intPaths[i] === ':id' || (intPaths[i].startsWith('{') && intPaths[i].endsWith('}')))) {
          interceptorIds.push(uriPaths[i]);
          continue;
        }
        interceptorPathOk = intPaths[i] === uriPaths[i];
      }
    }
    if (interceptorPathOk) {
      if (interceptor.query) {
        const intQuery = interceptor.query as Map<string, string[]>;
        for (const item of intQuery.entries()) {
          const params = uriQuery.get(item[0]);
          interceptorQueryOk = params && item[1].every(value => params.includes(value));
          if (!interceptorQueryOk) {
            break;
          }
        }
      }
    }
    return interceptorPathOk && interceptorQueryOk;
  }

  private processInterceptResponse(interceptor: IRequestInterceptor, utils: IInterceptorUtils): Observable<any> {
    const response = this.interceptResponse(interceptor, utils);
    if (response instanceof Observable) {
      return response;
    }
    if (response !== undefined) {
      return new Observable(observer => {
        if ((response as IHttpErrorResponse).error) {
          observer.error(response);
        } else {
          observer.next(response);
          observer.complete();
        }
      });
    }
    return undefined;
  }

  private interceptResponse(interceptor: IRequestInterceptor, utils: IInterceptorUtils):
    IHttpResponse<any> | IHttpErrorResponse | Observable<any> | undefined {
    let response: IHttpResponse<any> | IHttpErrorResponse;
    if (interceptor.response) {
      if (interceptor.response instanceof Function) {
        response = interceptor.response.call(this, utils);
      } else {
        response = clone(interceptor.response);
      }
    }
    return response;
  }

  /**
   * Get location info from a url, even on server where `document` is not defined
   */
  private getLocation(url: string): IUriInfo {
    if (!url.startsWith('http')) {
      // get the document iff running in browser
      const doc: Document = (typeof document === 'undefined') ? undefined : document;
      // add host info to url before parsing.  Use a fake host when not in browser.
      const base = doc ? doc.location.protocol + '//' + doc.location.host : 'http://fake';
      url = url.startsWith('/') ? base + url : base + '/' + url;
    }
    return parseUri(url);
  }

  private applyReplaceMap(pathSegments: string[]): string[] {
    for (const item of this.replaceMap.entries()) {
      const segments = item[1];
      let match = true;
      let i = 0;
      for (; i < segments.length && i < pathSegments.length && match; i++) {
        if (segments[i] !== pathSegments[i]) {
          match = false;
        }
      }
      if (match) {
        pathSegments.splice(0, i, item[0]);
        break;
      }
    }
    return pathSegments;
  }

  /**
   * Parses the request URL into a `ParsedRequestUrl` object.
   * Parsing depends upon certain values of `config`: `apiBase`, `host`, and `urlRoot`.
   *
   * Configuring the `apiBase` yields the most interesting changes to `parseRequestUrl` behavior:
   *   When apiBase=undefined and url='http://localhost/api/collection/42'
   *     {base: 'api/', collectionName: 'collection', id: '42', ...}
   *   When apiBase='some/api/root/' and url='http://localhost/some/api/root/collection'
   *     {base: 'some/api/root/', collectionName: 'collection', id: undefined, ...}
   *   When apiBase='/' and url='http://localhost/collection'
   *     {base: '/', collectionName: 'collection', id: undefined, ...}
   *
   * The actual api base segment values are ignored. Only the number of segments matters.
   * The following api base strings are considered identical: 'a/b' ~ 'some/api/' ~ `two/segments'
   *
   * To replace this default method, assign your alternative to your InMemDbService['parseRequestUrl']
   */
  protected parseRequestUrl(method: string, url: string, intInfo: IInterceptorInfo): IParsedRequestUrl {
    try {
      const parsed: IParsedRequestUrl = {
        apiBase: undefined,
        collectionName: undefined,
        id: undefined,
        query: undefined,
        resourceUrl: undefined,
      };
      const loc = this.getLocation(url);
      let drop = this.config.rootPath.length;
      let urlRoot = '';
      if (loc.host !== this.config.host) {
        // url for a server on a different host!
        // assume it's collection is actually here too.
        drop = 1; // the leading slash
        urlRoot = loc.protocol + '//' + loc.host + '/';
      }
      const path = loc.path.substring(drop);
      const query = paramParser(loc.query);
      let pathSegments = path.split('/');
      let segmentIx = 0;

      if (this.hasRequestInterceptor('complete', method, null, pathSegments, query, intInfo)) {
        return parsed;
      }

      // apiBase: the front part of the path devoted to getting to the api route
      // Assumes first path segment if no config.apiBase
      // else ignores as many path segments as are in config.apiBase
      // Does NOT care what the api base chars actually are.
      // tslint:disable-next-line:triple-equals
      if (this.config.apiBase == undefined) {
        parsed.apiBase = pathSegments[segmentIx++];
      } else {
        parsed.apiBase = removeTrailingSlash(this.config.apiBase.trim());
        if (parsed.apiBase) {
          segmentIx = parsed.apiBase.split('/').length;
        } else {
          segmentIx = 0; // no api base at all; unwise but allowed.
        }
      }
      parsed.apiBase += '/';
      parsed.query = query;

      pathSegments = this.applyReplaceMap(pathSegments.slice(segmentIx));
      segmentIx = 0;
      parsed.collectionName = pathSegments[segmentIx++];
      // ignore anything after a '.' (e.g.,the "json" in "customers.json")
      parsed.collectionName = parsed.collectionName && parsed.collectionName.split('.')[0];
      parsed.resourceUrl = urlRoot + parsed.apiBase + parsed.collectionName + '/';

      if (this.hasRequestInterceptor('beforeId', method, parsed.collectionName, pathSegments.slice(segmentIx), query, intInfo)) {
        return parsed;
      }

      parsed.id = pathSegments[segmentIx++];

      if (pathSegments.length > segmentIx) {
        if (this.hasRequestInterceptor('afterId', method, parsed.collectionName, pathSegments.slice(segmentIx), query, intInfo)) {
          return parsed;
        }
      }

      const extras = pathSegments.length > segmentIx ? pathSegments.slice(segmentIx).join('/') : undefined;
      if (extras) {
        parsed['extras'] = extras;
      }

      return parsed;

    } catch (err) {
      const msg = `unable to parse url '${url}'; original error: ${err.message}`;
      throw new Error(msg);
    }
  }

  private getPostToOtherMethod(collectionName: string, urlExtras?: string, query?: Map<string, string[]>, body?: any): string {
    let method = 'POST';
    let postsToOtherMethod = this.postToOtherMethodMap.get(collectionName);
    if (postsToOtherMethod === undefined) {
      postsToOtherMethod = this.config.postsToOtherMethod;
    }
    if (postsToOtherMethod !== undefined) {
      let found = false;
      for (const postToOtherMethod of postsToOtherMethod) {
        switch (postToOtherMethod.applyTo) {
          case 'urlSegment':
            const segments = urlExtras ? urlExtras.split('/').filter(value => value.trim().length > 0) : [];
            found = segments.reverse().filter(segment => segment === postToOtherMethod.value).length > 0;
            break;
          case 'queryParam':
            const queryParam = query ? query.get(postToOtherMethod.param) : undefined;
            found = queryParam && queryParam.length > 0 && queryParam[0] === postToOtherMethod.value;
            break;
          case 'bodyParam':
            found = body && body[postToOtherMethod.param] && body[postToOtherMethod.param] === postToOtherMethod.value;
            break;
        }
        if (found) {
          method = postToOtherMethod.otherMethod;
          break;
        }
      }
    }
    return method;
  }

  /**
   * get or create the function that passes unhandled requests
   * through to the "real" backend.
   */
  protected getPassThruBackend(): IPassThruBackend {
    return this.passThruBackend ?
      this.passThruBackend :
      this.passThruBackend = this.utils.createPassThruBackend();
  }

  private createInterceptorUtils(
    url: string, id?: string, interceptorIds?: string[], query?: Map<string, string[]>, body?: any
  ): IInterceptorUtils {
    return {
      url,
      id,
      interceptorIds,
      query,
      body,
      fn: {
        response: this.utils.createResponseOptions,
        errorResponse: this.utils.createErrorResponseOptions
      }
    };
  }

}
