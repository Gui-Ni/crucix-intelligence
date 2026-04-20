# -*- coding: utf-8 -*-
# QMT持仓查询脚本 — 输出JSON格式供Crucix调用
# 使用方法: python qmt_positions.py

import sys
import time
import json
from datetime import datetime

try:
    from xtquant.xttrader import XtQuantTrader
    from xtquant.xttype import StockAccount
except ImportError:
    print(json.dumps({"error": "xtquant模块未安装，请先 pip install xtquant"}))
    sys.exit(1)

# QMT配置 — 请修改为你的实际路径和账号
QMT_PATH = r'C:\Users\admin\Desktop\QMT量化工具'
ACCOUNT = "8885494243"  # 替换为你的账号

def main():
    session_id = int(time.time())
    xt_trader = XtQuantTrader(QMT_PATH, session_id)

    # 连接QMT终端
    if xt_trader.connect() != 0:
        print(json.dumps({"error": "QMT终端连接失败，请确认QMT客户端已登录运行"}))
        sys.exit(1)

    # 订阅账户
    account = StockAccount(ACCOUNT)
    if xt_trader.subscribe(account) != 0:
        print(json.dumps({"error": "账户订阅失败，请检查账号是否正确"}))
        sys.exit(1)

    # 查询账户资产
    asset = xt_trader.query_stock_asset(account)
    if not asset:
        print(json.dumps({"error": "无法获取账户资产信息"}))
        sys.exit(1)

    # 查询持仓
    positions = xt_trader.query_stock_positions(account)
    position_list = []
    for pos in positions:
        position_list.append({
            "stock_code": pos.stock_code,
            "volume": pos.volume,
            "can_use_volume": pos.can_use_volume,
            "frozen_volume": pos.frozen_volume,
            "open_price": pos.open_price,
            "market_value": pos.market_value,
            "on_road_volume": pos.on_road_volume,
            "yesterday_volume": pos.yesterday_volume,
        })

    # 查询当日委托
    orders = xt_trader.query_stock_orders(account)
    order_list = []
    for order in orders:
        order_list.append({
            "stock_code": order.stock_code,
            "order_volume": order.order_volume,
            "price": order.price,
            "order_id": order.order_id,
            "status_msg": order.status_msg,
            "order_time": datetime.fromtimestamp(order.order_time).strftime('%H:%M:%S') if order.order_time else '',
        })

    # 查询当日成交
    trades = xt_trader.query_stock_trades(account)
    trade_list = []
    for trade in trades:
        trade_list.append({
            "stock_code": trade.stock_code,
            "traded_volume": trade.traded_volume,
            "traded_price": trade.traded_price,
            "traded_amount": trade.traded_amount,
            "order_id": trade.order_id,
            "traded_time": datetime.fromtimestamp(trade.traded_time).strftime('%H:%M:%S') if trade.traded_time else '',
        })

    result = {
        "account_id": asset.account_id,
        "total_asset": asset.total_asset,
        "market_value": asset.market_value,
        "cash": asset.cash,
        "frozen_cash": asset.frozen_cash,
        "positions": position_list,
        "orders": order_list,
        "trades": trade_list,
    }

    print(json.dumps(result, ensure_ascii=False))

if __name__ == "__main__":
    main()
