
[![Greenkeeper badge](https://badges.greenkeeper.io/interledgerjs/moneyd-uplink-xrp.svg)](https://greenkeeper.io/)

## Run with [Docker](https://docs.docker.com/install/)

```sh
sudo docker build -t moneyd-xrp .
sudo docker volume create moneyd-cfg
sudo docker run --rm -v moneyd-cfg:/root/.moneyd -it moneyd-xrp xrp:configure
sudo docker run --rm -v moneyd-cfg:/root/.moneyd:ro -e "DEBUG=*" -p 7768:7768 moneyd-xrp xrp:start
```
