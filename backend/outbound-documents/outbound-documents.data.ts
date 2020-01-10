
import { dataService, IBackendService, IInterceptorUtils } from 'web-backend-api/src';
import { collectionName, outboundDocuments, transformPost, transformPut } from './outbound-documents.mock';
import { IOutboundDocument } from 'src/app/entities/outbound-documents/outbound-document.interface';
import { collectionName as customerCollection } from '../customers/customers.mock';
import { map } from 'rxjs/operators';

const transformGetEntity = (document: IOutboundDocument, dbService: IBackendService) => {
  return dbService.getInstance$(customerCollection, document.customerId).pipe(
    map(customer => {
      document['customer'] = customer;
      return document;
    })
  );
};

// configuration for collection `Outbound Documents`
dataService(collectionName, (dbService: IBackendService) => {

  // replace for url: http://{host:port}/api/documents/outbound
  // collection url after replace is: http://{host:port}/api/{collectionName}
  dbService.addReplaceUrl(collectionName, 'documents/outbound');

  dbService.addPostToOtherMethodMap(collectionName, {
    otherMethod: 'PUT',
    applyTo: 'urlSegment',
    value: 'alterar'
  });

  // add customer object to entity
  dbService.addTransformGetByIdMap(collectionName, transformGetEntity);

  // add atribute createdAt
  dbService.addTransformPostMap(collectionName, transformPost);

  // add or update atribute updatedAt
  dbService.addTransformPutMap(collectionName, transformPut);

  // apply a custom rule to filter on field customerId
  dbService.addFieldFilterMap(collectionName, 'customerId', 'eq');

  // apply a custom filter function on only query field createdAtStart
  const filterByCreatedAtStart = (dateFilter: string, document: IOutboundDocument): boolean => {
    return document.createdAt >= new Date(dateFilter);
  };
  dbService.addFieldFilterMap(collectionName, 'createdAtStart', filterByCreatedAtStart);

  // apply a custom rule to filter on only query field createdAtEnd
  const filterByCreatedAtEnd = (dateFilter: string, document: IOutboundDocument): boolean => {
    return document.createdAt <= new Date(dateFilter);
  };
  dbService.addFieldFilterMap(collectionName, 'createdAtEnd', filterByCreatedAtEnd);

  // apply a custom filter function in document list by productId
  const filterByProductId = (productId: string, document: IOutboundDocument): boolean => {
    return document.items.filter(item => item.productId.toString() === productId).length > 0;
  };
  dbService.addFieldFilterMap(collectionName, 'productId', filterByProductId);

  // add interceptor to generate a document identifier
  dbService.addRequestInterceptor({
    method: 'POST',
    path: 'identifier',
    applyToPath: 'beforeId',
    collectionName,
    response: (utils: IInterceptorUtils) => {
      const identifier = Math.floor(Math.random() * (9000000000 - 1000000000)) + 1000000000;
      return utils.fn.response(utils.url, 200, {identifier});
    }
  });

  // add existing mock data to collection initial data
  outboundDocuments.forEach((outboundDocument) => {
    dbService.storeData(collectionName, outboundDocument);
  });
});