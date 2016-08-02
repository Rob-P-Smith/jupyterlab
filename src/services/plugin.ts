// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import * as services
from 'jupyter-js-services';

import {
  Token
} from 'phosphor/lib/core/token';

import {
  JupyterLabPlugin
} from '../application';


/* tslint:disable */
/**
 * The default services provider token.
 */
export
const IServiceManager = new Token<IServiceManager>('jupyter.services.services');
/* tslint:enable */


/**
 * The service manager interface.
 */
export
interface IServiceManager extends services.IServiceManager { };


/**
 * The default services provider.
 */
export
const servicesProvider: JupyterLabPlugin<IServiceManager> = {
  id: 'jupyter.services.services',
  provides: IServiceManager,
  activate: (): Promise<IServiceManager> => {
    return services.createServiceManager() as Promise<IServiceManager>;
  }
};
