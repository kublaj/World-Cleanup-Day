'use strict';
/**
 * This is a database abstraction layer. The application should
 * use the methods exported here exclusively, for all its data
 * persistance needs, and never use lower-level database access.
 * The interface of this layer (method parameters and returns)
 * MUST be kept consistent across all other abstraction layers.
 */

const util = require('module-util');
const cdb = require('./driver');
const adapter = require('./adapter');
const types =  require('../types');
const grid =  require('../../geo/grid');

const RETRY_CONFLICTS = 3;

const layer = {
    //========================================================
    // COMMON
    //========================================================
    ready: () => cdb.SERVER_READY,

    //========================================================
    // DATASETS
    //========================================================
    getDataset: async id => {
        return await adapter.getOneEntityById('Dataset', '_design/all/_view/view', id);
    },
    getAllDatasets: async () => {
        return await adapter.getEntities('Dataset', '_design/all/_view/view', {sorted: false});
    },
    createDataset: async type => {
        const id = util.uuid.random();
        await adapter.createDocument('Dataset', id, {
            type,
        }, {
            createdAt: util.time.getNowUTC(),
        });
        return await layer.getDataset(id);
    },

    //========================================================
    // ACCOUNTS
    //========================================================
    getAccounts: async (pageSize = 10, pageNumber = 1) => {
        return await adapter.getEntities(
            'Account',
            '_design/byName/_view/view',
            {
                sorted: true,
                limit: pageSize,
                skip: pageSize * (pageNumber - 1),
            }
        );
    },
    getAccountsByCountry: async (country, pageSize = 10, pageNumber = 1) => {
        return await adapter.getEntities(
            'Account',
            '_design/byCountryAndName/_view/view',
            {
                sorted: true,
                limit: pageSize,
                skip: pageSize * (pageNumber - 1),
                startkey: [country],
                endkey: [country, {}],
            }
        );
    },
    getAccountsByNameSearch: async (nameSearch, pageSize = 10, pageNumber = 1, country = null) => {
        return await adapter.getEntities(
            'Account',
            '_design/byNamePieces/_view/view',
            {
                reduce: false,
                sorted: true,
                limit: pageSize,
                skip: pageSize * (pageNumber - 1),
                startkey: country  ? [nameSearch, country] : [nameSearch],
                endkey: country ? [nameSearch, country, {}] : [nameSearch, {}],
            }
        );
    },
    countAccounts: async () => {
        const ret = await adapter.getRawDocs('Account', '_design/countAll/_view/view', {});
        if (!ret.length) {
            return 0;
        }
        return parseInt(ret.pop());
    },
    countAccountsForCountry: async country => {
        const ret = await adapter.getRawDocs('Account', '_design/countByCountry/_view/view', {
            key: country,
            group: true,
        });
        if (!ret.length) {
            return 0;
        }
        return parseInt(ret.pop());
    },
    countAccountsForNameSearch: async (nameSearch, country = null) => {
        const ret = await adapter.getRawDocs('Account', '_design/byNamePieces/_view/view', {
            startkey: country  ? [nameSearch, country] : [nameSearch],
            endkey: country ? [nameSearch, country, {}] : [nameSearch, {}],
            reduce: true,
            group: false,
        });
        if (!ret.length) {
            return 0;
        }
        return parseInt(ret.pop());
    },
    getAccount: async id => {
        return await adapter.getOneEntityById('Account', '_design/all/_view/view', id);
    },
    getRawAccountDoc: async id => {
        return await adapter.getOneRawDocById('Account', '_design/all/_view/view', id);
    },
    modifyAccount: async (id, who, update, rawAccountDoc = null) => {
        return await adapter.modifyDocument(
            'Account',
            rawAccountDoc || await layer.getRawAccountDoc(id),
            update,
            {
                updatedAt: util.time.getNowUTC(),
                updatedBy: who,
            }
        );
    },
    createAccount: async (id, name, email, role, pictureURL) => {
        await adapter.createDocument('Account', id, {
            name,
            email,
            role,
            pictureURL,
        }, {
            locked: false,
            createdAt: util.time.getNowUTC(),
            createdBy: id,
        });
        return await layer.getAccount(id);
    },
    updateAccountTerms: async id => {
        const account = await layer.getRawAccountDoc(id);
        if (!account) {
            return false;
        }
        if (account.termsAcceptedAt) {
            return true;
        }
        const ret = await adapter.modifyDocument(
            'Account',
            account,
            {},
            {
                termsAcceptedAt: util.time.getNowUTC(),
                updatedAt: util.time.getNowUTC(),
                updatedBy: id,
            }
        );
        if (!ret) {
            return false;
        }
        return true;
    },
    setAccountLock: async (accountId, locked, updatedBy, rawAccountDoc = null) => {
        rawAccountDoc = rawAccountDoc || await layer.getRawAccountDoc(accountId);
        if (!rawAccountDoc) {
            return false;
        }
        const ret = await adapter.modifyDocument(
            'Account',
            rawAccountDoc,
            {},
            {
                locked,
                updatedAt: util.time.getNowUTC(),
                updatedBy,
            }
        );
        if (!ret) {
            return false;
        }
        return true;
    },

    //========================================================
    // SESSIONS
    //========================================================
    getSession: async id => {
        return await adapter.getOneEntityById('Session', '_design/all/_view/view', id);
    },
    touchSession: async (id, expirationDays) => {
        // XXX: This function is particularly susceptible to race conditions.
        // There are updates coming in sometimes as fast as 10ms behind each other.
        // We retry the timestamp update several times, since it's the only method
        // that works with Couch's optimistic locking. A successful update breaks
        // the cycle. A conflict error retries. Any other error throws.
        for (let i = 0; i < RETRY_CONFLICTS; i++) {
            try {
                return await adapter.modifyDocument(
                    'Session',
                    await adapter.getOneRawDocById('Session', '_design/all/_view/view', id),
                    {
                        expiresAt: util.time.getNowUTCShifted(expirationDays, 'd'),
                        updatedAt: util.time.getNowUTC(),
                    }
                );
            } catch (e) {
                if (e.code !== 'EDOCCONFLICT') {
                    throw e;
                }
            }
        }
    },
    createOrTouchSession: async (accountId, expirationDays) => {
        const id = types.Session.makeSessionIdFromAccountId(accountId);
        // assume session exists, attempt to update it
        const session = await layer.touchSession(id, expirationDays);
        // if it was there, all done, return it
        if (session) {
            return session;
        }
        // we didn't find it, so create it and return it
        await adapter.createDocument('Session', id, {
            accountId,
        }, {
            expiresAt: util.time.getNowUTCShifted(expirationDays, 'd'),
            createdAt: util.time.getNowUTC(),
            updatedAt: util.time.getNowUTC(),
        });
        return await layer.getSession(id);
    },
    verifyAndTouchSession: async (id, expirationDays) => {
        const session = await layer.getSession(id);
        if (!session) {
            return false;
        }
        // check expiration time
        const now = util.time.getNowUTC();
        if (now >= session.expiresAt) {
            await layer.removeSession(id);
            return false;
        }
        // session is ok, extend the expiration time
        return await layer.touchSession(id, expirationDays);
    },
    removeSession: async id => {
        return await adapter.removeDocument('Session', '_design/all/_view/view', id);
    },

    //========================================================
    // TRASHPOINTS
    //========================================================
    getTrashpoint: async id => {
        return await adapter.getOneEntityById('Trashpoint', '_design/all/_view/view', id);
    },
    getRawTrashpointDoc: async id => {
        return await adapter.getOneRawDocById('Trashpoint', '_design/all/_view/view', id);
    },
    getAdminTrashpoints: async (pageSize = 10, pageNumber = 1) => {
        return await adapter.getEntities(
            'Trashpoint',
            '_design/byCreationTime/_view/view',
            {
                sorted: true,
                limit: pageSize,
                skip: pageSize * (pageNumber - 1),
                descending: true,
            }
        );
    },
    getAreaTrashpoints: async (areaCode, pageSize = 10, pageNumber = 1) => {
        return await adapter.getEntities(
            'Trashpoint',
            '_design/byArea/_view/view',
            {
                sorted: true,
                limit: pageSize,
                skip: pageSize * (pageNumber - 1),
                descending: true, //XXX: when descending, startkey and endkey are reversed
                startkey: [areaCode, {}],
                endkey: [areaCode],
            }
        );
    },
    getUserTrashpoints: async (userId, pageSize = 10, pageNumber = 1) => {
        return await adapter.getEntities(
            'Trashpoint',
            '_design/byCreatingUser/_view/view',
            {
                sorted: true,
                descending: true, //XXX: when desc=true, startkey and endkey are reversed
                startkey: [userId, {}],
                endkey: [userId],
                limit: pageSize,
                skip: pageSize * (pageNumber - 1),
            }
        );
    },
    getGridCellTrashpoints: async (datasetId, cellSize, gridCoord) => {
        const scale = grid.getScaleForCellSize(cellSize);
        const ret = await adapter.getEntities(
            'Trashpoint',
            `_design/byGridCell${scale}/_view/view`,
            {
                startkey: [datasetId, gridCoord],
                endkey: [datasetId, gridCoord],
                'inclusive_end': true,
                sorted: false,
            }
        );
        return ret.filter(val => val !== null);
    },
    getOverviewTrashpoints: async (datasetId, cellSize, nwLat, nwLong, seLat, seLong) => {
        const scale = grid.getScaleForCellSize(cellSize);
        const ret = await layer.getOverview('Trashpoint', `_design/isolated${scale}/_view/view`,
            datasetId, scale, nwLat, nwLong, seLat, seLong);
        return ret.filter(row => adapter.rawDocToEntity('Trashpoint', row));
    },
    getOverviewClusters: async (datasetId, cellSize, nwLat, nwLong, seLat, seLong) => {
        const scale = grid.getScaleForCellSize(cellSize);
        const ret = await layer.getOverview('Trashpoint', `_design/clusters${scale}/_view/view`,
            datasetId, scale, nwLat, nwLong, seLat, seLong, {
                'group_level': 2,
            });
        return ret.filter(row => adapter.rawDocToEntity('Cluster', row));
    },
    getOverview: async (datatype, view, datasetId, scale, nwLat, nwLong, seLat, seLong, extraViewParams = {}) => {
        const cellCoords = grid.geoCornersToCells(
            [nwLong, nwLat], [seLong, seLat], grid.SCALES[scale]);
        const ret = await adapter.getRawDocs(
            datatype,
            view,
            Object.assign({
                startkey: [datasetId, cellCoords[0]],
                endkey: [datasetId, cellCoords[1]],
                'inclusive_end': true,
                group: true,
                reduce: true,
                sorted: false,
            }, extraViewParams),
            false // leave data untouched, we need the keys
        );
        if (!ret || !ret.data || !ret.data.rows) {
            return [];
        }
        return ret.data.rows
            .filter(row => row.value !== null)
            //XXX: filter cell coords here because couch stops after matching the 1st coord and returns cells that are vertically outside the area
            .filter(row => grid.cellIsInGridArea(row.key[1], cellCoords[0], cellCoords[1]))
            .map(row => {
                const val = row.value;
                val.coordinates = row.key[1];
                return val;
            })
        ;
    },
    countUserTrashpoints: async userId => {
        const ret = await adapter.getRawDocs(
            'Trashpoint',
            '_design/countByCreatingUser/_view/view', {
                key: userId,
            });
        if (!ret.length) {
            return 0;
        }
        return parseInt(ret.pop());
    },
    countTrashpoints: async () => {
        const ret = await adapter.getRawDocs(
            'Trashpoint',
            '_design/countAll/_view/view',
            {
                group: false,
            }
        );
        if (!ret.length) {
            return 0;
        }
        return parseInt(ret.pop());
    },
    modifyTrashpoint: async (id, who, update, rawTrashpointDoc = null) => {
        return await adapter.modifyDocument(
            'Trashpoint',
            rawTrashpointDoc || await layer.getRawTrashpointDoc(id),
            update,
            {
                updatedAt: util.time.getNowUTC(),
                updatedBy: who,
            }
        );
    },
    touchTrashpoint: async (id, who) => {
        return await layer.modifyTrashpoint(id, who, {});
    },
    createTrashpoint: async (datasetId, who, create) => {
        create.counter = 1, //FIXME: generate this number using a couchbase atomic counter
        create.datasetId = datasetId;
        create.hashtags = create.hashtags || [];

        const id = util.uuid.random();
        await adapter.createDocument('Trashpoint', id, create, {
            updatedAt: util.time.getNowUTC(),
            updatedBy: who,
            createdAt: util.time.getNowUTC(),
            createdBy: who,
        });

        return await layer.getTrashpoint(id);
    },
    removeTrashpoint: async id => {
        return await adapter.removeDocument('Trashpoint', '_design/all/_view/view', id);
    },

    //========================================================
    // IMAGES
    //========================================================
    getImage: async id => {
        return await adapter.getOneEntityById('Image', '_design/all/_view/view', id);
    },
    allocateImage: async (type, trashpointId, who, parentId = undefined) => {
        const id = util.uuid.random();
        await adapter.createDocument('Image', id, {
            type,
            status: types.Image.STATUS_PENDING,
            trashpointId,
            parentId,
        }, {
            updatedAt: util.time.getNowUTC(),
            updatedBy: who,
            createdAt: util.time.getNowUTC(),
            createdBy: who,
        });

        return await layer.getImage(id);
    },
    modifyImage: async (id, who, update, rawImageDoc = null) => {
        return await adapter.modifyDocument(
            'Image',
            rawImageDoc || await adapter.getOneRawDocById('Image', '_design/all/_view/view', id),
            update,
            {
                updatedAt: util.time.getNowUTC(),
                updatedBy: who,
            }
        );
    },
    removeImage: async id => {
        return await adapter.removeDocument('Image', '_design/all/_view/view', id);
    },
    getTrashpointImages: async (trashpointId, status = null) => {
        const ret = await adapter.getEntities(
            'Image',
            '_design/byTrashpointAndStatusAndCreation/_view/view',
            {
                descending: true, //XXX: when desc=true, startkey and endkey are reversed
                startkey: status ? [trashpointId, status, {}] : [trashpointId, {}],
                endkey: status ? [trashpointId, status] : [trashpointId],
                sorted: true,
            }
        );
        return ret;
    },
    getChildImages: async (parentId, trashpointId) => {
        const ret = await adapter.getEntities(
            'Image',
            '_design/byTrashpointAndParent/_view/view',
            {
                keys: [
                    [trashpointId, parentId],
                ],
                sorted: false,
            }
        );
        return ret;
    },

    //========================================================
    // AREAS
    //========================================================
    getArea: async id => {
        return await adapter.getOneEntityById('Area', '_design/all/_view/view', id);
    },
    getAllAreas: async () => {
        const ret = await adapter.getEntities('Area', '_design/all/_view/view', {sorted: false});
        return ret;
    },
    getAreasByParent: async parentId => {
        return await adapter.getEntities(
            'Area',
            `_design/byParent/_view/view`,
            {
                startkey: parentId || null,
                endkey: parentId || null,
                'inclusive_end': true,
                sorted: false,
            }
        );
    },
    getAreasForLeader: async leaderId => {
        return await adapter.getEntities(
            'Area',
            `_design/byLeader/_view/view`,
            {
                startkey: leaderId,
                endkey: leaderId,
                'inclusive_end': true,
                sorted: false,
            }
        );
    },
    countLeaderAreas: async leaderId => {
        const ret = await adapter.getRawDocs('Area', `_design/countByLeader/_view/view`, {
            key: leaderId,
        });
        if (!ret.length) {
            return 0;
        }
        return parseInt(ret.pop());
    },
    getRawAreaDoc: async id => {
        return await adapter.getOneRawDocById('Area', '_design/all/_view/view', id);
    },
    modifyArea: async (id, who, update, rawAreaDoc = null) => {
        return await adapter.modifyDocument(
            'Area',
            rawAreaDoc || await layer.getRawAreaDoc(id),
            update,
            {
                updatedAt: util.time.getNowUTC(),
                updatedBy: who || undefined,
            }
        );
    },
    seedAreas: async (metadata) => {
        const ret = await layer.getAllAreas();
        if (!Array.isArray(ret)) {
            return false;
        }
        const existingAreas = ret.reduce((prev, area) => {
            prev[area.id] = area;
            return prev;
        }, {});
        for (let area of metadata) {
            if (!existingAreas[area.code]) {
                await adapter.createDocument('Area', area.code, {
                    name: area.name,
                    parentId: area.parent || undefined,
                });
            }
            else {
                if (existingAreas[area.code].name !== area.name
                    || existingAreas[area.code].parentId !== area.parent
                ) {
                    await layer.modifyArea(area.code, null, {
                        name: area.name,
                        parentId: area.parent || undefined,
                    });
                }
            }
        }
        return true;
    },
    countAreaTrashpoints: async (areaCode, byStatus = false) => {
        const ret = await adapter.getRawDocs(
            'Trashpoint',
            '_design/countAreaStatus/_view/view', {
                group: true,
                'group_level': byStatus ? 2 : 1,
                startkey: [areaCode],
                endkey: [areaCode, {}],
            },
            byStatus ? false : true // for statuses we'll need the keys
        );
        if (byStatus) {
            if (!ret || !ret.data || !ret.data.rows || !ret.data.rows.length) {
                return {};
            }
            return ret.data.rows.reduce((all, row) => {
                all[row.key[1]] = row.value;
                return all;
            }, {});
        }
        else {
            if (!ret.length) {
                return 0;
            }
            return parseInt(ret.pop());
        }
    },
    areaIsInherited: async (leaderId, areaId) => {
        // compute area ancestors
        const ancestorAreas = [];
        areaId.split('.').reduce((prefix, codeBit) => {
            ancestorAreas.push(prefix + codeBit);
            return prefix + codeBit + '.';
        }, '');
        ancestorAreas.pop();
        // fetch areas where this user is leader
        const assignedAreas = (await layer.getAreasForLeader(leaderId)).map(area => area.id);
        if (!assignedAreas.length) {
            return false;
        }
        // see if any of them is among the ancestors
        for (let ancestorCode of ancestorAreas) {
            if (assignedAreas.indexOf(ancestorCode) !== -1) {
                return true;
            }
        }
        return false;
    },
};

module.exports = layer;
