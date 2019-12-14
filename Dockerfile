FROM node:10 as build
WORKDIR /usr/src/app

COPY package.json package-lock.json ./
RUN npm install --production

COPY . ./

FROM node:10-slim

RUN npm install -g moneyd --unsafe-perm

COPY --from=build /usr/src/app /usr/local/lib/node_modules/moneyd/node_modules/moneyd-uplink-xrp

EXPOSE 7768
ENTRYPOINT [ "/usr/local/bin/moneyd" , "-c", "/root/.moneyd/.moneyd.json" ]
