/* jslint node: true */
'use strict';

//  ENiGMA½
const { MenuModule }            = require('./menu_module.js');
const StatLog                   = require('./stat_log.js');
const User                      = require('./user.js');
const sysDb                     = require('./database.js').dbs.system;

//  deps
const moment            = require('moment');
const async             = require('async');
const _                 = require('lodash');

exports.moduleInfo = {
    name        : 'Last Callers',
    desc        : 'Last callers to the system',
    author      : 'NuSkooler',
    packageName : 'codes.l33t.enigma.lastcallers'
};

const MciCodeIds = {
    CallerList      : 1,
};

exports.getModule = class LastCallersModule extends MenuModule {
    constructor(options) {
        super(options);

        this.actionIndicators        = _.get(options, 'menuConfig.config.actionIndicators', {});
        this.actionIndicatorDefault  = _.get(options, 'menuConfig.config.actionIndicatorDefault', '-');
    }

    mciReady(mciData, cb) {
        super.mciReady(mciData, err => {
            if(err) {
                return cb(err);
            }

            async.waterfall(
                [
                    (next) => {
                        this.prepViewController('callers', 0, mciData.menu, err => {
                            return next(err);
                        });
                    },
                    (next) => {
                        this.fetchHistory( (err, loginHistory) => {
                            return next(err, loginHistory);
                        });
                    },
                    (loginHistory, next) => {
                        this.loadUserForHistoryItems(loginHistory, (err, updatedHistory) => {
                            return next(err, updatedHistory);
                        });
                    },
                    (loginHistory, next) => {
                        const callersView = this.viewControllers.callers.getView(MciCodeIds.CallerList);
                        callersView.setItems(loginHistory);
                        callersView.redraw();
                        return next(null);
                    }
                ],
                err => {
                    if(err) {
                        this.client.log.warn( { error : err.message }, 'Error loading last callers');
                    }
                    return cb(err);
                }
            );
        });
    }

    getCollapse(conf) {
        let collapse = _.get(this, conf);
        collapse = collapse && collapse.match(/^([0-9]+)\s*(minutes|seconds|hours|days|months)$/);
        if(collapse) {
            return moment.duration(parseInt(collapse[1]), collapse[2]);
        }
    }

    fetchHistory(cb) {
        const callersView = this.viewControllers.callers.getView(MciCodeIds.CallerList);
        if(!callersView || 0 === callersView.dimens.height) {
            return cb(null);
        }

        StatLog.getSystemLogEntries(
            'user_login_history',
            StatLog.Order.TimestampDesc,
            200,    //  max items to fetch - we need more than max displayed for filtering/etc.
            (err, loginHistory) => {
                if(err) {
                    return cb(err);
                }

                const dateTimeFormat = _.get(
                    this, 'menuConfig.config.dateTimeFormat', this.client.currentTheme.helpers.getDateFormat('short'));

                loginHistory = loginHistory.map(item => {
                    try {
                        const historyItem = JSON.parse(item.log_value);
                        if(_.isObject(historyItem)) {
                            item.userId     = historyItem.userId;
                            item.sessionId  = historyItem.sessionId;
                        } else {
                            item.userId     = historyItem;  //  older format
                            item.sessionId  = '-none-';
                        }
                    } catch(e) {
                        return null;    //  we'll filter this out
                    }

                    item.timestamp = moment(item.timestamp);

                    return Object.assign(
                        item,
                        {
                            ts : moment(item.timestamp).format(dateTimeFormat)
                        }
                    );
                });

                const hideSysOp     = _.get(this, 'menuConfig.config.sysop.hide');
                const sysOpCollapse = this.getCollapse('menuConfig.config.sysop.collapse');

                if(hideSysOp) {
                    loginHistory = loginHistory.filter(item => false === User.isRootUserId(item.userId));
                } else if(sysOpCollapse) {
                    //  :TODO: DRY op & user collapse code
                    const maxAge = sysOpCollapse.asSeconds();
                    let lastUserId;
                    let lastTimestamp;

                    loginHistory = loginHistory.filter(item => {
                        const op        = User.isRootUserId(item.userId);
                        const repeat    = lastUserId === item.userId;
                        const recent    = lastTimestamp ? moment.duration(lastTimestamp.diff(item.timestamp)).seconds() < maxAge : false;

                        lastUserId = item.userId;
                        lastTimestamp = item.timestamp;

                        return !op || !repeat || !recent;
                    });
                }

                const userCollapse  = this.getCollapse('menuConfig.config.user.collapse');
                if(userCollapse) {
                    const maxAge = userCollapse.asSeconds();
                    let lastUserId;
                    let lastTimestamp;

                    loginHistory = loginHistory.filter(item => {
                        const repeat    = lastUserId === item.userId;
                        const recent    = lastTimestamp ? moment.duration(lastTimestamp.diff(item.timestamp)).seconds() < maxAge : false;

                        lastUserId = item.userId;
                        lastTimestamp = item.timestamp;

                        return !repeat || !recent;
                    });
                }

                return cb(
                    null,
                    loginHistory.slice(0, callersView.dimens.height)      //  trim the fat
                );
            }
        );
    }

    loadUserForHistoryItems(loginHistory, cb) {
        const getPropOpts = {
            names : [  'real_name', 'location', 'affiliation' ]
        };

        const actionIndicatorNames = _.map(this.actionIndicators, (v, k) => k);
        let indicatorSumsSql;
        if(actionIndicatorNames.length > 0) {
            indicatorSumsSql = actionIndicatorNames.map(i => {
                return `SUM(CASE WHEN log_value='${_.snakeCase(i)}' THEN 1 ELSE 0 END) AS ${i}`;
            });
        }

        async.map(loginHistory, (item, next) => {
            User.getUserName(item.userId, (err, userName) => {
                if(err) {
                    return cb(null, null);
                }

                item.userName = item.text = (userName || 'N/A');

                User.loadProperties(item.userId, getPropOpts, (err, props) => {
                    item.location       = (props && props.location) || 'N/A';
                    item.affiliation    = item.affils = (props && props.affiliation) || 'N/A';
                    item.realName       = (props && props.real_name) || 'N/A';

                    if(!indicatorSumsSql) {
                        return next(null, item);
                    }

                    sysDb.get(
                        `SELECT ${indicatorSumsSql.join(', ')}
                        FROM user_event_log
                        WHERE user_id=? AND session_id=?
                        LIMIT 1;`,
                        [ item.userId, item.sessionId ],
                        (err, results) => {
                            if(_.isObject(results)) {
                                item.actions = '';
                                Object.keys(results).forEach(n => {
                                    const indicator = results[n] > 0 ? this.actionIndicators[n] || this.actionIndicatorDefault : this.actionIndicatorDefault;
                                    item[n] = indicator;
                                    item.actions += indicator;
                                });
                            }
                            return next(null, item);
                        }
                    );
                });
            });
        },
        (err, mapped) => {
            return cb(err, mapped.filter(item => item));    //  remove deleted
        });
    }
};
