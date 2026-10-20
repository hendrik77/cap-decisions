@requires: 'authenticated-user'
service DecisionService {
  action classify(message: String) returns String;
}
